# Strava OAuth2 Setup

## 1. Create a Strava API Application

1. Go to https://www.strava.com/settings/api
2. Create an application with:
   - **Application Name:** Obsidian Sync (or anything)
   - **Category:** Data Importer
   - **Website:** http://localhost
   - **Authorization Callback Domain:** localhost
3. After saving, the page shows your app's details. Note:
   - **Client ID** — shown in the app summary
   - **Client Secret** — click "Show" next to the Client Secret field to reveal it

## 2. Get Your Initial Refresh Token

### Step A: Authorize

Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all&approval_prompt=force
```

You'll be redirected to `http://localhost/?code=AUTHORIZATION_CODE&scope=...`. Copy the `code` value from the URL.

### Step B: Exchange for Tokens

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=AUTHORIZATION_CODE \
  -d grant_type=authorization_code
```

The response contains:
- `access_token` — used for API calls (expires in 6 hours)
- `refresh_token` — used to get new access tokens (this is what you configure in Node-RED)
- `expires_at` — Unix epoch when the access token expires

## 3. Get a Google Maps Static API Key (Optional)

This enables route map images in your daily notes. Without it, activities fall back to an OpenStreetMap text link.

1. Go to https://console.cloud.google.com/
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services → Library**
4. Search for **Maps Static API** and click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → API key**
7. Copy the generated key
8. (Recommended) Click **Edit API key** to restrict it:
   - Under **API restrictions**, select **Restrict key** and choose only **Maps Static API**
   - Under **Application restrictions**, you can leave it unrestricted for local use

The free tier includes 28,000 static map loads per month, which is more than enough for personal activity tracking.

## 4. Configure Node-RED

Edit both inject nodes in the Strava flow with:
- `clientId` — your Client ID
- `clientSecret` — your Client Secret
- `refreshToken` — the refresh_token from Step B
- `vaultPath` — path to your Obsidian daily notes folder (e.g., `/kms/10 PMS/11 Daily Notes`)
- `googleMapsKey` — your Google Maps Static API key from Step 3 (leave as `YOUR_GOOGLE_MAPS_KEY` to use OSM links instead)

The flow will automatically refresh tokens as needed. The refresh token and access token are persisted in Node-RED's file-backed flow context, so they survive restarts.

## Token Lifecycle

- Access tokens expire every 6 hours
- The flow checks `expiresAt` before each API call
- When expired, it POSTs to `/oauth/token` with the stored refresh token
- Strava may issue a new refresh token in the response — the flow stores this automatically
- The initial `refreshToken` in the inject node is only used on first deploy (before any tokens are persisted)
