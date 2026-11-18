# Meta Facebook + Instagram Setup Guide

This project already contains the OAuth and Meta connection flow. The remaining work is to configure the real Meta developer app, public callback URLs, and app review requirements.

## 1) Required environment variables

Copy `backend/.env.example` to `backend/.env` and fill in the values below.

```env
META_APP_ID=...
META_APP_SECRET=...
META_INSTAGRAM_APP_ID=...
META_INSTAGRAM_APP_SECRET=...
META_GRAPH_VERSION=v21.0
META_REDIRECT_URI=https://your-public-domain.example.com/api/channels/meta/oauth/callback
META_INSTAGRAM_REDIRECT_URI=https://your-public-domain.example.com/api/channels/meta/oauth/instagram/callback
WEBHOOK_BASE_URL=https://your-public-domain.example.com
META_VERIFY_TOKEN=change_me_verify_token
META_PRIVACY_POLICY_URL=https://your-domain.example.com/privacy
META_DEAUTH_CALLBACK_URL=https://your-domain.example.com/api/meta/deauthorize
META_DATA_DELETION_URL=https://your-domain.example.com/delete-account
```

## 2) Create a Meta Business app

1. Go to Meta for Developers.
2. Create a Business app.
3. Add the following products:
   - Messenger
   - Instagram Messaging
   - WhatsApp
4. In App settings, add the App Domains and redirect URIs used by the app.
5. Set the app to Business type, not consumer.

## 3) Required redirect URIs

Add each callback URL in Meta Dashboard > Facebook Login > Settings > Valid OAuth Redirect URIs:

- `https://your-public-domain.example.com/api/channels/meta/oauth/callback`
- `https://your-public-domain.example.com/api/channels/meta/oauth/start`
- `https://your-public-domain.example.com/api/channels/meta/oauth/instagram/callback` (if using the Instagram Login flow)

## 4) Facebook Login for Business (Page access)

Use the existing server-side OAuth flow in `backend/src/services/meta.service.js` and `backend/src/modules/channels/channels.routes.js`.

Required scopes:

- `pages_show_list`
- `pages_read_engagement`
- `pages_manage_posts`
- `pages_manage_engagement`
- `pages_messaging`
- `business_management` (only when required by your app configuration)

The app verifies the OAuth state before exchanging the code and stores the resulting Page access token securely.

## 5) Instagram login + publishing

### Option A: Instagram API with Instagram Login

Use the dedicated Instagram app values from Meta App Dashboard > Instagram > API setup.

Scopes:

- `instagram_business_basic`
- `instagram_business_content_publish`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Notes:
- The auth code is single-use and valid for about one hour.
- Strip the trailing `#_` from the code in the redirect.
- Exchange the code for a short-lived token, then refresh to a long-lived token.
- Store the token encrypted and refresh before expiry.

### Option B: Instagram with Facebook Login for Business

Use the same Meta app that owns the Facebook Page linked to the Instagram professional account.

Scopes:

- `instagram_basic`
- `instagram_content_publish`
- `instagram_manage_comments`
- `pages_show_list`
- `pages_read_engagement`

Only professional or creator accounts work. Personal accounts should show a clear message to switch to a professional account.

## 6) Publishing flow

Instagram publishing must follow the container > status poll > publish flow:

1. `POST /{ig-user-id}/media` to create a media container
2. Poll `GET /{ig-user-id}/media?fields=status_code` until status is `FINISHED`
3. `POST /{ig-user-id}/media_publish` to publish
4. Use public URLs for the media being uploaded
5. Check `GET /{ig-id}/content_publishing_limit` before publishing

Instagram has a limit of 100 API posts per 24 hours, so the app should queue publishing and surface a warning when the limit is reached.

## 7) Webhooks

For inbound comments/messages, verify:

- `X-Hub-Signature-256`
- verify-token handshake on the initial setup
- app secret proof on Graph API calls
- callback validation for deauthorization events

## 8) Required compliance URLs

Meta app review commonly asks for:

- Privacy Policy URL
- Data Deletion Callback endpoint or instructions page
- Deauthorize callback URL

These should be set in your Meta App Dashboard and also stored in the app configuration (`META_PRIVACY_POLICY_URL`, `META_DEAUTH_CALLBACK_URL`, `META_DATA_DELETION_URL`).

## 9) Test checklist

### Connect
- [ ] Save Meta App ID and secret
- [ ] Start OAuth in the dashboard
- [ ] Confirm the callback lands on the configured redirect URI
- [ ] Select a Facebook Page and/or Instagram business account
- [ ] Account appears in the connected accounts list

### Publish
- [ ] Publish a text post to a Page
- [ ] Publish a photo post to Instagram
- [ ] Publish a carousel
- [ ] Publish a Reel
- [ ] Publish a Story

### Refresh token / reconnect
- [ ] Confirm token is refreshed before expiry
- [ ] Force expired token and verify the app marks the account `needs_reconnect`
- [ ] Disconnect and reconnect an account

### Error handling
- [ ] Invalid/expired token shows a reconnect warning
- [ ] Rate limit is handled with backoff
- [ ] Permission revoked shows a reconnect or reauth action

## 10) App review / live mode

For permissions beyond the test accounts you own, Meta requires:

- App Review
- Business Verification
- Test users/roles configured for QA
- Live mode when going beyond your own accounts

This is required before production access to real user data.
