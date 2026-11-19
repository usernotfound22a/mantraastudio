/**
 * Channels - the settings screen for connected accounts.
 *
 * Three ways a channel gets created:
 *   - POST /api/channels                     manual (website widget, or API-driven)
 *   - POST /api/channels/meta/connect        OAuth: Facebook Page + Instagram
 *   - the website widget is always creatable without any third party
 *
 * The Meta OAuth routes are registered BEFORE `/:channelId` so "meta" is never
 * parsed as an id.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, loadWorkspace, requireRole } from '../../middleware/auth.js';
import { queryOf, validate } from '../../middleware/validate.js';
import { asyncHandler, AppError } from '../../middleware/error.js';
import { updateRows } from '../../db/supabase.js';
import {
  listChannelsForWorkspace,
  getChannelById,
  createChannel,
  updateChannelConfig,
  setChannelStatus,
  deleteChannel,
  generateWidgetKey,
  toPublicChannel,
} from '../../services/channels.service.js';
import { listAdapterCatalogue, listAdapterTypes } from '../../adapters/registry.js';
import { env } from '../../config/env.js';
import { childLogger } from '../../config/logger.js';
import { emitToWorkspace } from '../../services/socket.service.js';
import { EVENTS } from '../../services/events.js';
import { getMetaSettings, isMetaConfigured, saveMetaSettings } from '../../services/meta-settings.service.js';
import {
  buildOAuthUrl,
  buildInstagramLoginUrl,
  signOAuthState,
  verifyOAuthState,
  signConnectToken,
  verifyConnectToken,
  getConnectSession,
  exchangeCodeForUserToken,
  exchangeInstagramCodeForToken,
  refreshInstagramLongLivedToken,
  listManagedPages,
  listManagedWhatsAppAccounts,
  exchangeForLongLivedToken,
  subscribePageToWebhooks,
  subscribeWhatsAppAccountToWebhooks,
  unsubscribePageFromWebhooks,
  unsubscribeWhatsAppAccountFromWebhooks,
  fetchInstagramAccount,
  fetchInstagramBusinessProfile,
  webhookCallbackUrl,
  publicPage,
  publishPagePost,
  classifyMetaApiError,
} from '../../services/meta.service.js';
import {
  findSocialAccountByExternalId,
  getDecryptedAccessToken,
  listSocialAccountsForWorkspace,
  upsertSocialAccount,
  markSocialAccountNeedsReconnect,
} from '../../services/socialAccount.service.js';

const router = Router();

const log = childLogger('channels');

const idParam = z.object({ channelId: z.coerce.number().int().positive() });

/**
 * Which environment variables a channel type needs before it can work.
 *
 * Returning the variable NAMES (never the values) lets the dashboard grey out
 * a channel that cannot possibly connect and tell the developer exactly what to
 * set, instead of letting them fill in a form and fail at the OAuth step.
 */
const CHANNEL_REQUIREMENTS = {
  messenger: ['META_APP_ID', 'META_APP_SECRET', 'WEBHOOK_BASE_URL'],
  instagram: ['META_APP_ID', 'META_APP_SECRET', 'WEBHOOK_BASE_URL'],
  whatsapp: ['META_APP_ID', 'META_APP_SECRET', 'WEBHOOK_BASE_URL'],
  website: [],
  telegram: ['TELEGRAM_BOT_TOKEN'],
};

/** Decides whether a channel type is connectable in this deployment. */
function channelAvailability(adapter) {
  const required = CHANNEL_REQUIREMENTS[adapter.type] ?? [];
  const metaSettings = getMetaSettings();
  const present = (name) => {
    if (name === 'META_APP_ID') return metaSettings.appId;
    if (name === 'META_APP_SECRET') return metaSettings.appSecret;
    return env[name];
  };
  const missing = required.filter((name) => !present(name));

  if (!required.length) {
    return {
      available: true,
      mode: 'local',
      missing: [],
      reason: 'Works with no external credentials.',
    };
  }
  if (!missing.length) {
    return { available: true, mode: 'external', missing: [], reason: 'Credentials present.' };
  }
    return {
      available: false,
      mode: 'external',
      missing,
      reason: ['messenger', 'instagram', 'whatsapp'].includes(adapter.type)
        ? missing.includes('WEBHOOK_BASE_URL')
          ? 'Set WEBHOOK_BASE_URL in backend/.env to a public HTTPS URL.'
          : 'Save the Meta App ID and App Secret in Channels settings.'
        : `Set ${missing.join(', ')} in backend/.env to connect this channel.`,
    };
}

/** Reads a channel and proves it belongs to the caller's workspace. */
async function ownedChannel(req) {
  const channel = await getChannelById(req.params.channelId);
  if (!channel || channel.workspace_id !== req.workspace.id) {
    throw AppError.notFound('Channel not found');
  }
  return channel;
}

// ---------------------------------------------------------------------------
// Meta OAuth  (registered first: /meta/... must beat /:channelId)
// ---------------------------------------------------------------------------

/** Read safe Meta setup status; the App Secret is never returned. */
router.get(
  '/meta/config',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const settings = getMetaSettings();
    res.json({
      appId: settings.appId,
      hasAppSecret: Boolean(settings.appSecret),
      configured: isMetaConfigured(),
    });
  }),
);

/** Save deployment-wide Meta credentials; encryptSecret runs in the service. */
router.put(
  '/meta/config',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    body: z.object({
      appId: z.string().trim().min(1).max(100),
      appSecret: z.string().trim().max(500).optional(),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    res.json(await saveMetaSettings({
      ...req.body,
      updatedBy: req.user.id,
      workspaceId: req.workspace.id,
    }));
  }),
);

/** What the connect button needs to render. Tells the UI what is possible. */
router.get(
  '/meta/availability',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    res.json({
      configured: isMetaConfigured(),
      publicUrl: env.WEBHOOK_BASE_URL ?? null,
      webhookUrls: {
        messenger: webhookCallbackUrl('messenger'),
        instagram: webhookCallbackUrl('instagram'),
        whatsapp: webhookCallbackUrl('whatsapp'),
      },
      connectable: ['messenger', 'instagram', 'whatsapp'].filter((type) => listAdapterTypes().includes(type)),
    });
  }),
);

/** Authenticated XHR endpoint: browser navigation cannot attach its bearer token. */
router.get(
  '/meta/oauth/url',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const state = signOAuthState({ workspaceId: req.workspace.id, userId: req.user.id });
    res.json({ url: buildOAuthUrl(state) });
  }),
);

/** Step 1: 302 to Facebook. `?redirect` is echoed in the state. */
router.get(
  '/meta/oauth/start',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    query: z.object({ redirect: z.string().max(500).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const state = signOAuthState({
      workspaceId: req.workspace.id,
      userId: req.user.id,
    });
    res.redirect(302, buildOAuthUrl(state));
  }),
);

/** Instagram Business Login path. */
router.get(
  '/meta/instagram/oauth/url',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const state = signOAuthState({ workspaceId: req.workspace.id, userId: req.user.id });
    res.json({ url: buildInstagramLoginUrl(state) });
  }),
);

router.get(
  '/meta/instagram/oauth/start',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  asyncHandler(async (req, res) => {
    const state = signOAuthState({ workspaceId: req.workspace.id, userId: req.user.id });
    res.redirect(302, buildInstagramLoginUrl(state));
  }),
);

router.get(
  '/meta/instagram/oauth/callback',
  validate({
    query: z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      error: z.string().optional(),
      error_reason: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { code, state, error, error_reason: errorReason } = queryOf(req);
    const returnToChannels = new URL('/settings/channels', env.FRONTEND_URL);

    if (error || errorReason) {
      returnToChannels.searchParams.set('error', `Instagram: ${error ?? errorReason}`);
      return res.redirect(302, returnToChannels.toString());
    }

    if (!code || !state) {
      returnToChannels.searchParams.set('error', 'Instagram did not return an authorisation code');
      return res.redirect(302, returnToChannels.toString());
    }

    const { workspaceId, userId } = verifyOAuthState(state);
    const tokenResult = await exchangeInstagramCodeForToken(code);
    const profile = await fetchInstagramBusinessProfile(tokenResult.accessToken);
    const longLived = await refreshInstagramLongLivedToken(tokenResult.accessToken);

    if (profile) {
      await upsertSocialAccount({
        workspaceId,
        platform: 'instagram',
        externalId: String(profile.id),
        name: profile.username || profile.name || 'Instagram account',
        avatarUrl: profile.profile_picture_url || null,
        accessToken: longLived.token,
        tokenExpiresAt: longLived.expiresAt?.toISOString() ?? null,
        scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],
        status: 'connected',
        connectedBy: userId,
        metadata: { accountType: profile.account_type ?? null, profile },
      });
    }

    const connectToken = signConnectToken({
      workspaceId,
      userId,
      userAccessToken: longLived.token,
      instagramProfile: profile,
      pages: [],
      whatsappAccounts: [],
    });
    returnToChannels.searchParams.set('connectToken', connectToken);
    returnToChannels.searchParams.set('platform', 'instagram');
    return res.redirect(302, returnToChannels.toString());
  }),
);

/**
 * Step 2/3: Meta calls us back. We exchange the code, list the user's Pages and
 * hand the browser an OPAQUE connectToken - no Meta token leaves the server.
 */
router.get(
  '/meta/oauth/callback',
  validate({
    query: z.object({
      code: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      error_reason: z.string().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { code, state, error_reason: errorReason } = queryOf(req);
    const returnToChannels = new URL('/settings/channels', env.FRONTEND_URL);

    if (errorReason) {
      returnToChannels.searchParams.set('error', `Facebook: ${errorReason}`);
      return res.redirect(302, returnToChannels.toString());
    }
    if (!code || !state) {
      returnToChannels.searchParams.set('error', 'Facebook did not return an authorisation code');
      return res.redirect(302, returnToChannels.toString());
    }

    const { workspaceId, userId } = verifyOAuthState(state);
    const userAccessToken = await exchangeCodeForUserToken(code);
    const [pages, whatsappAccounts] = await Promise.all([
      listManagedPages(userAccessToken).catch(() => []),
      listManagedWhatsAppAccounts(userAccessToken),
    ]);
    if (pages.length === 0 && whatsappAccounts.length === 0) {
      returnToChannels.searchParams.set('error', 'No Facebook Pages or WhatsApp Business numbers were found for this account.');
      return res.redirect(302, returnToChannels.toString());
    }

    const connectToken = signConnectToken({ workspaceId, userId, userAccessToken, pages, whatsappAccounts });
    returnToChannels.searchParams.set('connectToken', connectToken);
    return res.redirect(302, returnToChannels.toString());
  }),
);

/** Return safe account choices while keeping Meta tokens on the server. */
router.get(
  '/meta/connect/:connectToken',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const session = getConnectSession(req.params.connectToken);
    if (session.workspaceId !== req.workspace.id || session.userId !== req.user.id) {
      throw AppError.forbidden('That connect link belongs to a different account');
    }
    res.json({
      pages: (session.pages ?? []).map(publicPage),
      whatsappAccounts: session.whatsappAccounts ?? [],
    });
  }),
);

/**
 * Step 4-6: the user picked a Page. Create one channel row per requested type
 * (a single Page can be both Messenger and Instagram).
 */
router.post(
  '/meta/connect',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    body: z.object({
      connectToken: z.string().min(10),
      pageId: z.string().min(1).max(100).optional(),
      types: z.array(z.enum(['messenger', 'instagram', 'whatsapp'])).min(1),
      whatsappBusinessAccountId: z.string().min(1).max(100).optional(),
      phoneNumberId: z.string().min(1).max(100).optional(),
      pageName: z.string().max(150).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { connectToken, pageId, types, whatsappBusinessAccountId, phoneNumberId, pageName } = req.body;
    const session = getConnectSession(connectToken);

    if (session.workspaceId !== req.workspace.id || session.userId !== req.user.id) {
      throw AppError.forbidden('That connect link belongs to a different account');
    }

    const socialTypes = types.filter((type) => type !== 'whatsapp');
    const page = socialTypes.length
      ? (session.pages ?? []).find((candidate) => candidate.id === pageId)
      : null;
    if (socialTypes.length && !page) {
      throw AppError.badRequest('That Page was not in the list you authorised');
    }

    const whatsappAccount = types.includes('whatsapp')
      ? (session.whatsappAccounts ?? []).find((account) => account.id === whatsappBusinessAccountId)
      : null;
    const phone = whatsappAccount?.phoneNumbers.find((candidate) => candidate.id === phoneNumberId);
    if (types.includes('whatsapp') && !phone) {
      throw AppError.badRequest('Choose a WhatsApp Business Account and phone number from the authorised list');
    }

    // Consume only after ownership and selected account checks pass.
    const payload = verifyConnectToken(connectToken);
    const { token: pageToken, expiresAt } = page
      ? await exchangeForLongLivedToken(page._pageAccessToken)
      : { token: null, expiresAt: null };
    const pageSubscription = page ? await subscribePageToWebhooks(pageId, pageToken) : { ok: true };

    const instagram = types.includes('instagram') ? await fetchInstagramAccount(pageId, pageToken) : null;
    if (types.includes('instagram') && !instagram) {
      log.warn({ pageId }, 'Instagram requested but the Page has no linked Instagram business account');
    }

    const created = [];
    for (const type of socialTypes) {
      if (type === 'instagram' && !instagram) continue;

      const externalId = type === 'instagram' ? instagram.id : pageId;
      const name =
        type === 'instagram' ? `IG: ${instagram.username ?? page.name}` : (pageName ?? page.name);

      try {
        const channel = await createChannel({
          workspaceId: req.workspace.id,
          type,
          name,
          externalId,
          config: {
            pageId,
            accessToken: pageToken,
            appSecret: getMetaSettings().appSecret ?? null,
            verifyToken: env.META_VERIFY_TOKEN,
            ...(type === 'instagram' ? { instagramUserId: instagram.id, username: instagram.username } : {}),
            tokenExpiresAt: expiresAt?.toISOString() ?? null,
            webhooksSubscribed: pageSubscription.ok,
          },
          connectedBy: req.user.id,
        });

        if (type === 'instagram' && instagram) {
          await upsertSocialAccount({
            workspaceId: req.workspace.id,
            platform: 'instagram',
            externalId: String(instagram.id),
            name: instagram.username || instagram.name || 'Instagram business account',
            avatarUrl: instagram.profile_pic || null,
            accessToken: pageToken,
            tokenExpiresAt: expiresAt?.toISOString() ?? null,
            scopes: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_comments', 'instagram_business_manage_messages'],
            status: 'connected',
            connectedBy: req.user.id,
            metadata: { pageId, pageName: page.name },
          });
        }

        if (type === 'messenger') {
          await upsertSocialAccount({
            workspaceId: req.workspace.id,
            platform: 'facebook',
            externalId: String(pageId),
            name: pageName ?? page.name,
            accessToken: pageToken,
            tokenExpiresAt: expiresAt?.toISOString() ?? null,
            scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_engagement', 'pages_messaging'],
            status: 'connected',
            connectedBy: req.user.id,
            metadata: { pageId, pageName: page.name },
          });
        }

        created.push(toPublicChannel(channel));
      } catch (error) {
        // A duplicate remote account is a normal outcome, not a crash: the user
        // may have connected the same Page before. Skip it and keep the rest.
        if (error.statusCode !== 409) throw error;
        created.push({ error: error.message, type, externalId });
      }
    }

    let whatsappSubscription = { ok: true };
    if (whatsappAccount && phone) {
      const { token: accessToken, expiresAt: tokenExpiresAt } = await exchangeForLongLivedToken(payload.userAccessToken);
      whatsappSubscription = await subscribeWhatsAppAccountToWebhooks(whatsappAccount.id, accessToken);
      try {
        const channel = await createChannel({
          workspaceId: req.workspace.id,
          type: 'whatsapp',
          name: phone.verifiedName || phone.displayPhoneNumber || whatsappAccount.name,
          externalId: phone.id,
          config: {
            phoneNumberId: phone.id,
            businessAccountId: whatsappAccount.id,
            displayPhoneNumber: phone.displayPhoneNumber,
            accessToken,
            appSecret: getMetaSettings().appSecret ?? null,
            verifyToken: env.META_VERIFY_TOKEN,
            tokenExpiresAt: tokenExpiresAt?.toISOString() ?? null,
            webhooksSubscribed: whatsappSubscription.ok,
          },
          connectedBy: req.user.id,
        });
        created.push(toPublicChannel(channel));
      } catch (error) {
        if (error.statusCode !== 409) throw error;
        created.push({ error: error.message, type: 'whatsapp', externalId: phone.id });
      }
    }

    if (created.length === 0) {
      throw AppError.conflict(
        'That account is already connected to another SocialHub workspace',
      );
    }

    res.status(201).json({
      channels: created,
      // Surfaced so the settings screen can tell the user what to do next.
      warnings: [
        ...(!pageSubscription.ok ? ['Could not subscribe the Facebook Page to webhooks.'] : []),
        ...(!whatsappSubscription.ok ? ['Could not subscribe the WhatsApp Business Account to webhooks.'] : []),
      ],
    });
  }),
);

router.post(
  '/meta/pages/:pageId/publish',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    body: z.object({
      message: z.string().max(5000).optional(),
      imageUrl: z.string().url().optional(),
      videoUrl: z.string().url().optional(),
      link: z.string().url().optional(),
      scheduledAt: z.string().datetime().optional(),
    }).refine((value) => Boolean(value.message || value.imageUrl || value.videoUrl), {
      message: 'A Facebook post needs text, a photo URL, or a video URL.',
    }),
  }),
  asyncHandler(async (req, res) => {
    const pageId = String(req.params.pageId);
    const account = await findSocialAccountByExternalId(req.workspace.id, 'facebook', pageId);
    const token = account ? getDecryptedAccessToken(account) : null;

    if (!token) {
      throw AppError.badRequest('No connected Facebook Page was found for this workspace. Please reconnect the page first.');
    }

    try {
      const result = await publishPagePost({
        pageId,
        pageAccessToken: token,
        message: req.body.message,
        imageUrl: req.body.imageUrl,
        videoUrl: req.body.videoUrl,
        link: req.body.link,
        scheduledAt: req.body.scheduledAt,
      });
      res.status(201).json(result);
    } catch (error) {
      const classification = classifyMetaApiError(error);
      if (account) {
        await markSocialAccountNeedsReconnect(account.id, classification.type || 'unknown');
      }
      throw AppError.serviceUnavailable(classification.message);
    }
  }),
);

router.post(
  '/meta/reconnect',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    body: z.object({
      platform: z.enum(['facebook', 'instagram']),
      externalId: z.string().min(1),
    }).strict(),
  }),
  asyncHandler(async (req, res) => {
    const account = await findSocialAccountByExternalId(req.workspace.id, req.body.platform, req.body.externalId);
    if (!account) {
      throw AppError.notFound('No connected account matches that platform and id');
    }

    const token = getDecryptedAccessToken(account);
    if (!token) {
      throw AppError.badRequest('This account does not have a stored token ready to reconnect.');
    }

    await upsertSocialAccount({
      workspaceId: req.workspace.id,
      platform: account.platform,
      externalId: String(account.external_id),
      name: account.name,
      avatarUrl: account.avatar_url,
      accessToken: token,
      tokenExpiresAt: account.token_expires_at,
      scopes: Array.isArray(account.scopes) ? account.scopes : [],
      status: 'connected',
      connectedBy: req.user.id,
      metadata: { ...(account.metadata ?? {}), reconnectRequestedAt: new Date().toISOString() },
    });

    res.json({ ok: true, status: 'connected', account: account.platform });
  }),
);

router.get(
  '/meta/accounts',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const accounts = await listSocialAccountsForWorkspace(req.workspace.id);
    res.json({ accounts });
  }),
);

// ---------------------------------------------------------------------------
// Catalogue of channel types the server supports
// ---------------------------------------------------------------------------

router.get(
    '/catalogue',
    authenticate,
    asyncHandler(async (req, res) => {
      res.json({
        channels: listAdapterCatalogue().map((adapter) => ({
          ...adapter,
          // Lets the UI grey out a channel that cannot work yet instead of
          // offering a connect button that is guaranteed to fail. Localhost is
          // always available so the offline channels stay demoable.
          availability: channelAvailability(adapter),
        })),
        connected: listAdapterTypes(),
      });
    }),
  );

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

router.get(
  '/',
  authenticate,
  loadWorkspace,
  asyncHandler(async (req, res) => {
    const channels = await listChannelsForWorkspace(req.workspace.id);
    res.json({ channels: channels.map(toPublicChannel) });
  }),
);

router.post(
  '/',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    body: z.object({
      // Not a fixed enum: whatever adapters are registered is valid, so adding
      // a channel never requires touching this file.
      type: z.string().min(2).max(40),
      name: z.string().trim().min(1).max(150),
      externalId: z.string().trim().max(191).optional(),
      config: z.record(z.any()).optional(),
      isDefault: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { type, name, externalId, config = {}, isDefault = false } = req.body;

    // Fail early with a helpful message rather than at webhook time.
    const known = listAdapterTypes();
    if (!known.includes(type)) {
      throw AppError.badRequest(`Unknown channel type "${type}". Supported: ${known.join(', ')}`);
    }

    const finalConfig = { ...config };
    if (type === 'website') {
      finalConfig.widgetKey = finalConfig.widgetKey ?? generateWidgetKey(req.workspace.id);
      finalConfig.domain = finalConfig.domain ?? '*';
      finalConfig.greeting = finalConfig.greeting ?? 'Hi! How can we help you today?';
      finalConfig.themeColor = finalConfig.themeColor ?? '#6366f1';
    }

    const channel = await createChannel({
      workspaceId: req.workspace.id,
      type,
      name,
      externalId: externalId ?? null,
      config: finalConfig,
      isDefault,
      connectedBy: req.user.id,
    });

    res.status(201).json({ channel: toPublicChannel(channel) });
  }),
);

router.get(
  '/:channelId',
  authenticate,
  loadWorkspace,
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const channel = await ownedChannel(req);
    res.json({ channel: toPublicChannel(channel) });
  }),
);

router.patch(
  '/:channelId',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({
    params: idParam,
    body: z
      .object({
        name: z.string().trim().min(1).max(150).optional(),
        status: z.enum(['connected', 'disconnected', 'error']).optional(),
        isDefault: z.boolean().optional(),
        /** Merged into the existing config, so secrets survive an update. */
        config: z.record(z.any()).optional(),
      })
      .refine((value) => Object.keys(value).length > 0, {
        message: 'Provide at least one field to update',
      }),
  }),
  asyncHandler(async (req, res) => {
    const channel = await ownedChannel(req);
    const { name, status, isDefault, config } = req.body;

    const channelConfig = channel.config ?? {};
    const isPageChannel = ['messenger', 'instagram'].includes(channel.type);
    const isWhatsAppChannel = channel.type === 'whatsapp';

    if (status === 'connected' && channel.status !== 'connected' && (isPageChannel || isWhatsAppChannel)) {
      if (!channelConfig.accessToken) {
        throw AppError.serviceUnavailable('This channel has no saved provider token. Reconnect it through Meta authorization.');
      }
      const subscription = isPageChannel
        ? await subscribePageToWebhooks(channelConfig.pageId, channelConfig.accessToken)
        : await subscribeWhatsAppAccountToWebhooks(channelConfig.businessAccountId, channelConfig.accessToken);
      if (subscription && !subscription.ok) {
        throw AppError.serviceUnavailable('Meta could not resubscribe this channel to webhooks. Check the channel token and permissions.');
      }
    }

    if (status === 'disconnected' && (isPageChannel || isWhatsAppChannel) && channelConfig.accessToken) {
      const unsubscribe = isWhatsAppChannel
        ? unsubscribeWhatsAppAccountFromWebhooks(channelConfig.businessAccountId, channelConfig.accessToken)
        : unsubscribePageFromWebhooks(channelConfig.pageId, channelConfig.accessToken);
      const result = await unsubscribe;
      if (!result.ok) {
        log.warn({ channelId: channel.id, type: channel.type }, 'Provider webhook unsubscribe failed; local channel will still disconnect');
      }
    }

    if (config) await updateChannelConfig(channel.id, config);
    if (status) await setChannelStatus(channel.id, status, null);
    if (name !== undefined) await updateRows('channels', { name }, { id: channel.id });
    if (isDefault !== undefined) {
      await updateRows('channels', { is_default: isDefault }, { id: channel.id });
    }

    // Other tabs show the settings screen, so tell them the channel changed.
    emitToWorkspace(req.workspace.id, EVENTS.CHANNEL_UPDATED, {
      channel: toPublicChannel(await getChannelById(channel.id)),
    });

    res.json({ channel: toPublicChannel(await getChannelById(channel.id)) });
  }),
);

/**
 * Rotating the widget key invalidates every existing embed. Gated to website
 * channels because it is the only channel whose credential is a public key.
 */
router.post(
  '/:channelId/regenerate-widget-key',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const channel = await ownedChannel(req);
    if (channel.type !== 'website') {
      throw AppError.badRequest('Only the website channel has a widget key');
    }
    const widgetKey = generateWidgetKey(req.workspace.id);
    await updateChannelConfig(channel.id, { widgetKey });
    res.json({
      channel: toPublicChannel(await getChannelById(channel.id)),
      widgetKey,
      warning: 'Existing embeds stop working. Update the script src in your site.',
    });
  }),
);

router.delete(
  '/:channelId',
  authenticate,
  loadWorkspace,
  requireRole('owner', 'admin'),
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const channel = await ownedChannel(req);

    if (['messenger', 'instagram', 'whatsapp'].includes(channel.type)) {
      const { accessToken, pageId } = channel.config ?? {};
      if (accessToken) {
        const result = channel.type === 'whatsapp'
          ? await unsubscribeWhatsAppAccountFromWebhooks(channel.config.businessAccountId, accessToken)
          : await unsubscribePageFromWebhooks(pageId, accessToken);
        if (!result.ok) {
          log.warn({ channelId: channel.id, type: channel.type }, 'Provider unsubscribe failed during channel deletion');
        }
      }
    }

    // Conversations and messages cascade-delete via foreign keys.
    await deleteChannel(channel.id);
    emitToWorkspace(req.workspace.id, EVENTS.CHANNEL_DELETED, { channelId: channel.id });
    res.sendStatus(204);
  }),
);

export default router;
