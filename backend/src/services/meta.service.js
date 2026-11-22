/**
 * Meta (Facebook / Instagram) OAuth + Page token management.
 *
 * Flow a workspace owner completes in Settings -> Channels:
 *
 *   1. GET  /api/channels/meta/oauth/start     -> 302 to Facebook login
 *   2. Facebook -> GET /api/channels/meta/oauth/callback?code=..&state=..
 *   3. We exchange the code for a USER token and list the Pages they manage
 *   4. The browser receives an opaque `connectToken` (never a Meta token)
 *   5. POST /api/channels/meta/connect { connectToken, pageId, channels: [...] }
 *   6. We exchange the page token for a LONG-LIVED token, subscribe the Page's
 *      webhooks to our app, and persist the channel row
 *
 * The design rule: **no Meta credential is ever handed to the browser**, and the
 * page choice is a server-signed, 10-minute token, so step 5 cannot be forged.
 */
import crypto from 'node:crypto';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { childLogger } from '../config/logger.js';
import { AppError } from '../middleware/error.js';
import { getMetaSettings } from './meta-settings.service.js';

const log = childLogger('meta');

/** Permissions: read pages, send messages, see the linked IG account. */
export const META_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'whatsapp_business_management',
  'whatsapp_business_messaging',
  'business_management',
].join(',');

/** Returns the signed app-secret proof used in Graph API calls. */
export function appSecretProof(accessToken, appSecret = getMetaSettings().appSecret) {
  if (!accessToken || !appSecret) return undefined;
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

export function verifyMetaSignedRequest(signedRequest) {
  if (typeof signedRequest !== 'string' || !signedRequest.includes('.')) {
    throw AppError.badRequest('Missing or invalid signed_request');
  }

  const [encodedSignature, encodedPayload] = signedRequest.split('.');
  const appSecret = getMetaSettings().appSecret;
  if (!appSecret) {
    throw AppError.serviceUnavailable('Meta App Secret is not configured');
  }

  try {
    const expected = crypto.createHmac('sha256', appSecret).update(encodedPayload).digest();
    const received = Buffer.from(encodedSignature, 'base64url');
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      throw new Error('signature mismatch');
    }
    return JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    throw AppError.badRequest('Invalid Meta signed_request');
  }
}

export function withAppSecretProof(accessToken, params = {}) {
  const proof = appSecretProof(accessToken);
  return {
    ...params,
    ...(proof ? { appsecret_proof: proof } : {}),
  };
}

/** The public URL Meta redirects back to. */
export function redirectUri() {
  if (env.META_REDIRECT_URI) return env.META_REDIRECT_URI;
  if (!env.WEBHOOK_BASE_URL) {
    throw AppError.serviceUnavailable(
      'WEBHOOK_BASE_URL is not set. Meta needs a public HTTPS URL - run a tunnel (ngrok/cloudflared) and put the URL in backend/.env.',
    );
  }
  return `${env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/channels/meta/oauth/callback`;
}

function assertConfigured() {
  const { appId, appSecret } = getMetaSettings();
  if (!appId || !appSecret) {
    throw AppError.serviceUnavailable(
      'Meta OAuth is not configured. Save the Meta App ID and App Secret in Channels > Meta settings.',
    );
  }
}

const graph = (path) => `https://graph.facebook.com/${env.META_GRAPH_VERSION}${path}`;

// ---------------------------------------------------------------------------
// CSRF: state (start -> callback) and connectToken (callback -> connect)
// ---------------------------------------------------------------------------

/** Short-lived state so the callback knows who started the flow and can't be CSRF'd. */
export function signOAuthState({ workspaceId, userId }) {
  assertConfigured();
  return jwt.sign({ workspaceId, userId, purpose: 'meta-oauth-state' }, env.JWT_SECRET, {
    expiresIn: '10m',
    issuer: 'socialhub',
  });
}

export function verifyOAuthState(state) {
  try {
    const payload = jwt.verify(state, env.JWT_SECRET, { issuer: 'socialhub' });
    if (payload.purpose !== 'meta-oauth-state') throw new Error('wrong purpose');
    return payload;
  } catch {
    throw AppError.badRequest('Invalid or expired OAuth state - please start the connection again');
  }
}

// ---------------------------------------------------------------------------
// connectToken
// ---------------------------------------------------------------------------
//
// The OAuth callback has to carry the chosen-Page candidates AND the short-lived
// Meta USER token across one more round trip to POST /meta/connect.
//
// It must NOT be a JWT containing the Meta token:
//   - a JWT payload is base64, not encrypted, so anyone holding the link can
//     read the Meta access token
//   - the value travels in a URL query string, so it lands in browser history,
//     Referer headers and access logs
//
// So the payload is kept server-side and the browser gets an opaque random
// handle. Leaked handles are useless to an attacker, and every entry expires.

/** opaque handle -> { payload, expiresAt } */
const connectTokens = new Map();
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Drops expired entries. Called opportunistically, not on a timer. */
function sweepConnectTokens() {
  const now = Date.now();
  for (const [handle, entry] of connectTokens) {
    if (entry.expiresAt <= now) connectTokens.delete(handle);
  }
}

/**
 * Stores the connect payload server-side and returns an opaque handle.
 * The handle is what the browser holds; the Meta token never leaves memory.
 */
export function signConnectToken({ workspaceId, userId, userAccessToken, pages, whatsappAccounts }) {
  sweepConnectTokens();

  const handle = crypto.randomBytes(32).toString('base64url');
  connectTokens.set(handle, {
    payload: { workspaceId, userId, userAccessToken, pages, whatsappAccounts },
    expiresAt: Date.now() + CONNECT_TOKEN_TTL_MS,
  });

  return handle;
}

/**
 * Resolves an opaque handle back to its payload.
 *
 * Single-use: the entry is deleted the moment it is read, so a leaked
 * screenshot of the connect URL cannot be replayed to attach a second page.
 */
export function verifyConnectToken(token) {
  const entry = connectTokens.get(token);
  if (!entry) {
    throw AppError.badRequest('This connect link has expired - start the connection again');
  }
  connectTokens.delete(token);

  if (entry.expiresAt <= Date.now()) {
    throw AppError.badRequest('This connect link has expired - start the connection again');
  }
  return entry.payload;
}

/** Reads the safe preview data without consuming the one-time connection token. */
export function getConnectSession(token) {
  sweepConnectTokens();
  const entry = connectTokens.get(token);
  if (!entry) {
    throw AppError.badRequest('This connect link has expired - start the connection again');
  }
  return entry.payload;
}

// ---------------------------------------------------------------------------
// OAuth calls
// ---------------------------------------------------------------------------

/** Step 1: where we send the browser. */
export function buildOAuthUrl(state) {
  assertConfigured();
  const { appId } = getMetaSettings();
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    state,
    scope: META_SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth?${params}`;
}

/** Step 2: short-lived user access token. */
export async function exchangeCodeForUserToken(code) {
  assertConfigured();
  const { appId, appSecret } = getMetaSettings();
  try {
    const { data } = await axios.get(graph('/oauth/access_token'), {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri(),
        code,
      },
      timeout: 15000,
    });
    return data.access_token;
  } catch (error) {
    log.warn({ err: error.message }, 'Meta code exchange failed');
    throw AppError.badRequest('Facebook rejected the authorisation code - please try again');
  }
}

/** Step 3: every Page this user manages. `tasks` tells us MESSAGING is enabled. */
export async function listManagedPages(userAccessToken) {
  try {
    const { data } = await axios.get(graph('/me/accounts'), {
      params: withAppSecretProof(userAccessToken, {
        access_token: userAccessToken,
        fields: 'id,name,access_token,instagram_business_account,tasks,followers_count',
        limit: 100,
      }),
      timeout: 15000,
    });

    return (data.data ?? []).map((page) => ({
      id: page.id,
      name: page.name,
      task: page.tasks?.[0] ?? null,
      hasMessenger: page.tasks?.includes('MESSAGING') ?? false,
      followers: page.followers_count ?? 0,
      instagram: page.instagram_business_account
        ? {
            id: page.instagram_business_account.id,
            username: page.instagram_business_account.username ?? null,
          }
        : null,
      // Internal: never returned to the browser (stripped before signing out).
      _pageAccessToken: page.access_token,
    }));
  } catch (error) {
    log.warn({ err: error.message }, 'Could not list managed pages');
    throw AppError.badRequest('Could not read your Facebook Pages - check the app permissions');
  }
}

/** WhatsApp Cloud API numbers the user can manage through their businesses. */
export async function listManagedWhatsAppAccounts(userAccessToken) {
  try {
    const { data: businessesResponse } = await axios.get(graph('/me/businesses'), {
      params: withAppSecretProof(userAccessToken, { access_token: userAccessToken, fields: 'id,name', limit: 100 }),
      timeout: 15000,
    });

    const accounts = await Promise.all(
      (businessesResponse.data ?? []).map(async (business) => {
        try {
          const { data } = await axios.get(graph(`/${business.id}/owned_whatsapp_business_accounts`), {
            params: withAppSecretProof(userAccessToken, {
              access_token: userAccessToken,
              fields: 'id,name,phone_numbers{id,display_phone_number,verified_name}',
              limit: 100,
            }),
            timeout: 15000,
          });
          return (data.data ?? []).map((account) => ({
            id: account.id,
            name: account.name ?? business.name,
            phoneNumbers: (account.phone_numbers?.data ?? []).map((phone) => ({
              id: phone.id,
              displayPhoneNumber: phone.display_phone_number ?? null,
              verifiedName: phone.verified_name ?? null,
            })),
          }));
        } catch (error) {
          log.warn({ businessId: business.id, err: error.message }, 'Could not list WhatsApp business accounts');
          return [];
        }
      }),
    );

    return accounts.flat().filter((account) => account.phoneNumbers.length > 0);
  } catch (error) {
    log.warn({ err: error.message }, 'Could not list WhatsApp business accounts');
    return [];
  }
}

/**
 * Page tokens expire in 60 days. Exchange for a long-lived one so a connected
 * page does not quietly break in the middle of the project. If the exchange
 * fails we keep the short-lived token rather than dropping the connection.
 * @returns {{token: string, expiresAt: Date|null}}
 */
export async function exchangeForLongLivedToken(token) {
  const { appId, appSecret } = getMetaSettings();
  try {
    const { data } = await axios.get(graph('/oauth/access_token'), {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: token,
      },
      timeout: 15000,
    });
    return {
      token: data.access_token,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
    };
  } catch (error) {
    log.warn({ err: error.message }, 'Long-lived token exchange failed - keeping short-lived token');
    return { token, expiresAt: null };
  }
}

/** Points the Page's webhooks at our app (POST /{page}/subscribed_apps). */
export async function subscribePageToWebhooks(pageId, pageAccessToken) {
  try {
    await axios.post(graph(`/${pageId}/subscribed_apps`), null, {
      params: withAppSecretProof(pageAccessToken, {
        access_token: pageAccessToken,
        subscribed_fields: 'messages,messaging_postbacks,messaging_optins,messaging_referrals,messaging_handovers',
      }),
      timeout: 15000,
    });
    return { ok: true };
  } catch (error) {
    log.warn(
      {
        pageId,
        httpStatus: error.response?.status,
        providerCode: error.response?.data?.error?.code,
        providerSubcode: error.response?.data?.error?.error_subcode,
        providerMessage: error.response?.data?.error?.message ?? error.message,
      },
      'Could not subscribe page to webhooks',
    );
    return { ok: false, error: error.message };
  }
}

/** Stops Meta calling us after a disconnect. */
export async function unsubscribePageFromWebhooks(pageId, pageAccessToken) {
  try {
    await axios.delete(graph(`/${pageId}/subscribed_apps`), {
      params: { access_token: pageAccessToken },
      timeout: 15000,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Subscribes a WhatsApp Business Account to this app's configured webhook fields. */
export async function subscribeWhatsAppAccountToWebhooks(accountId, accessToken) {
  try {
    await axios.post(graph(`/${accountId}/subscribed_apps`), null, {
      params: withAppSecretProof(accessToken, { access_token: accessToken }),
      timeout: 15000,
    });
    return { ok: true };
  } catch (error) {
    log.warn(
      {
        accountId,
        httpStatus: error.response?.status,
        providerCode: error.response?.data?.error?.code,
        providerSubcode: error.response?.data?.error?.error_subcode,
        providerMessage: error.response?.data?.error?.message ?? error.message,
      },
      'Could not subscribe WhatsApp account to webhooks',
    );
    return { ok: false, error: error.message };
  }
}

/** Stops Meta calling this app after a WhatsApp channel is disconnected. */
export async function unsubscribeWhatsAppAccountFromWebhooks(accountId, accessToken) {
  try {
    await axios.delete(graph(`/${accountId}/subscribed_apps`), {
      params: { access_token: accessToken },
      timeout: 15000,
    });
    return { ok: true };
  } catch (error) {
    log.warn(
      {
        accountId,
        httpStatus: error.response?.status,
        providerCode: error.response?.data?.error?.code,
        providerSubcode: error.response?.data?.error?.error_subcode,
        providerMessage: error.response?.data?.error?.message ?? error.message,
      },
      'Could not unsubscribe WhatsApp account from webhooks',
    );
    return { ok: false, error: error.message };
  }
}

/** The Instagram business account linked to a Page, if there is one. */
export async function fetchInstagramAccount(pageId, pageAccessToken) {
  try {
    const { data } = await axios.get(graph(`/${pageId}`), {
      params: withAppSecretProof(pageAccessToken, {
        fields: 'instagram_business_account{id,username,name,profile_pic}',
        access_token: pageAccessToken,
      }),
      timeout: 15000,
    });
    return data.instagram_business_account ?? null;
  } catch (error) {
    log.warn({ pageId, err: error.message }, 'No linked Instagram account');
    return null;
  }
}

/** The public URL the user registers in the Meta dashboard. */
export const webhookCallbackUrl = (channelType) =>
  env.WEBHOOK_BASE_URL
    ? `${env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/api/webhooks/${channelType}`
    : null;

/** Strips the internal page token before a page list is signed for the browser. */
export const publicPage = ({ _pageAccessToken, ...page }) => page;

/** Helper for Meta login URLs for a Business app. */
export function buildInstagramLoginUrl(state) {
  if (!env.META_INSTAGRAM_APP_ID) {
    throw AppError.serviceUnavailable('META_INSTAGRAM_APP_ID is not set');
  }
  const params = new URLSearchParams({
    client_id: env.META_INSTAGRAM_APP_ID,
    redirect_uri: env.META_INSTAGRAM_REDIRECT_URI || redirectUri(),
    state,
    scope: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages',
    response_type: 'code',
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export function classifyMetaApiError(error) {
  const payload = error?.response?.data?.error ?? {};
  const code = Number(payload.code ?? error?.response?.status ?? 0);
  const status = Number(error?.response?.status ?? 0);
  const message = String(payload.message ?? error?.message ?? 'Meta Graph API request failed');

  if (status === 429 || code === 4 || /rate limit|too many requests/i.test(message)) {
    return { type: 'rate_limited', message: 'Meta API rate limit reached. Please retry shortly.' };
  }

  if (code === 190 || /OAuthException|access token.*expired|session has expired|invalid OAuth access token|token.*invalid/i.test(message)) {
    return { type: 'expired_token', message: 'The Meta access token expired or was revoked. Please reconnect this account.' };
  }

  if (code === 200 || /permission|not authorized|requires review|insufficient privilege/i.test(message)) {
    return { type: 'permission', message: 'The connected Meta app is missing permissions. Please reconnect the account.' };
  }

  if (/user declined|denied by user|cancelled|cancelled by user/i.test(message)) {
    return { type: 'user_declined', message: 'The user cancelled the Meta login. Please reconnect when ready.' };
  }

  if (status === 401 || code === 190) {
    return { type: 'expired_token', message: 'The Meta access token is no longer valid. Please reconnect this account.' };
  }

  return { type: 'unknown', message };
}

export function instagramGraphUrl(path = '', version = env.META_GRAPH_VERSION) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `https://graph.instagram.com/${version}${normalizedPath}`;
}

export async function exchangeInstagramCodeForToken(code) {
  if (!env.META_INSTAGRAM_APP_ID || !env.META_INSTAGRAM_APP_SECRET) {
    throw AppError.serviceUnavailable('Instagram app credentials are not configured');
  }

  const cleanedCode = String(code || '').replace(/#_$/, '');
  const redirectUriValue = env.META_INSTAGRAM_REDIRECT_URI || redirectUri();

  try {
    const { data } = await axios.get('https://graph.instagram.com/oauth/access_token', {
      params: {
        client_id: env.META_INSTAGRAM_APP_ID,
        client_secret: env.META_INSTAGRAM_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: redirectUriValue,
        code: cleanedCode,
      },
      timeout: 15000,
    });

    return {
      accessToken: data.access_token,
      expiresIn: Number(data.expires_in ?? 0),
      userId: data.user_id ?? null,
    };
  } catch (error) {
    log.warn({ err: error.message }, 'Instagram OAuth code exchange failed');
    throw AppError.badRequest('Instagram rejected the authorisation code - please try again');
  }
}

export async function refreshInstagramLongLivedToken(shortLivedToken) {
  if (!env.META_INSTAGRAM_APP_ID || !env.META_INSTAGRAM_APP_SECRET) {
    throw AppError.serviceUnavailable('Instagram app credentials are not configured');
  }

  try {
    const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', {
      params: {
        grant_type: 'ig_refresh_token',
        access_token: shortLivedToken,
      },
      timeout: 15000,
    });

    return {
      token: data.access_token,
      expiresIn: Number(data.expires_in ?? 0),
      expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
    };
  } catch (error) {
    log.warn({ err: error.message }, 'Instagram long-lived token refresh failed');
    throw AppError.badRequest('Instagram token refresh failed - please reconnect the account');
  }
}

export async function fetchInstagramBusinessProfile(accessToken) {
  try {
    const { data } = await axios.get('https://graph.instagram.com/v22.0/me', {
      params: {
        fields: 'id,username,account_type,media_count,followers_count,profile_picture_url,name',
        access_token: accessToken,
      },
      timeout: 15000,
    });
    return data;
  } catch (error) {
    log.warn({ err: error.message }, 'Could not fetch Instagram business profile');
    return null;
  }
}

export async function publishPagePost({ pageId, pageAccessToken, message = '', imageUrl, videoUrl, link, scheduledAt }) {
  if (!pageId || !pageAccessToken) {
    throw AppError.badRequest('A Facebook Page id and access token are required for publishing');
  }

  const payload = {
    access_token: pageAccessToken,
    published: true,
    ...(message ? { message } : {}),
    ...(link ? { link } : {}),
    ...(scheduledAt ? { scheduled_publish_time: Math.floor(new Date(scheduledAt).getTime() / 1000) } : {}),
  };

  if (imageUrl) {
    const { data } = await axios.post(graph(`/${pageId}/photos`), {
      ...payload,
      url: imageUrl,
    }, {
      params: withAppSecretProof(pageAccessToken, { access_token: pageAccessToken }),
      timeout: 30000,
    });
    return { ok: true, kind: 'photo', data };
  }

  if (videoUrl) {
    const { data } = await axios.post(graph(`/${pageId}/videos`), {
      ...payload,
      file_url: videoUrl,
    }, {
      params: withAppSecretProof(pageAccessToken, { access_token: pageAccessToken }),
      timeout: 30000,
    });
    return { ok: true, kind: 'video', data };
  }

  const { data } = await axios.post(graph(`/${pageId}/feed`), payload, {
    params: withAppSecretProof(pageAccessToken, { access_token: pageAccessToken }),
    timeout: 30000,
  });

  return { ok: true, kind: 'post', data };
}
