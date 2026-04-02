# Strava to Obsidian

A Node-RED flow that syncs Strava activities into Obsidian daily notes as structured markdown.

## Features

### Three Operating Modes

- **Active Polling** — Automatically checks for new activities every 60 minutes. Starts 5 seconds after deploy.
- **Historic Bulk Loading** — Manually triggered to import all activities for a given year. Paginates through the full activity list.
- **Nightly Update** — Runs at 2 AM daily, re-fetches the last 7 days of activities and replaces existing entries with fresh data (updated kudos, comments, descriptions).

### Activity Detail

Each activity is fetched individually from the Strava detail API to get the full data, including:

- Distance, elevation gain, moving time, elapsed time
- Pace (for runs/walks/hikes) or speed (for rides/other)
- Average and max heart rate
- Kudos and comment counts
- Activity description
- Route map (static Google Maps image, or OpenStreetMap link as fallback)

### Markdown Output

Activities are inserted under a `## Notes` heading in the daily note for the activity's date:

```markdown
- 07:30 🏃 [Morning Run](https://www.strava.com/activities/123) : Run #strava
	- Early morning trail run through the park
	- **Distance:** 10.52 km | **Elevation:** 142 m
	- **Moving Time:** 52m 30s | **Elapsed Time:** 55m 12s
	- **Pace:** 4:59 /km | **Heart Rate:** 155 / 178 bpm
	- **Kudos:** 5 | **Comments:** 2
	- ![Map](https://maps.googleapis.com/maps/api/staticmap?...)
```

Activity type emojis: 🏃 Run, 🚴 Ride, 🏊 Swim, ⛰️ Hike, 🚶 Walk, 🧘 Yoga, 🏋️ Weights/Workout.

### Duplicate Prevention

- Activities are identified by their Strava ID in the note content
- Polling and historic modes skip activities already present in the daily note
- Nightly update mode replaces existing entries (matches the full activity block including sub-items)

### API Rate Limiting

Strava enforces 100 requests per 15 minutes and 1,000 per day.

- Detail API calls are queued at 6 per minute (~90 per 15 min), leaving headroom for list and auth calls
- All flows detect HTTP 429 responses and automatically retry after a 2-minute backoff
- Polling logs a warning on 429 and retries on the next hourly cycle

### OAuth2 Token Management

- Tokens are persisted in Node-RED's file-backed flow context (survive restarts)
- Access tokens are checked before each API call with a 60-second expiry buffer
- Refresh tokens are automatically updated when Strava issues new ones
- All three flows share the same token refresh sub-chain

## Setup

### 1. Create a Strava API Application

1. Go to https://www.strava.com/settings/api
2. Create an application with:
   - **Application Name:** Obsidian Sync (or anything)
   - **Category:** Data Importer
   - **Website:** http://localhost
   - **Authorization Callback Domain:** localhost
3. After saving, note your:
   - **Client ID** — shown in the app summary
   - **Client Secret** — click "Show" to reveal it

### 2. Get Your Initial Refresh Token

#### Step A: Authorize

Open this URL in your browser (replace `YOUR_CLIENT_ID`):

```
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all&approval_prompt=force
```

You'll be redirected to `http://localhost/?code=AUTHORIZATION_CODE&scope=...`. Copy the `code` value from the URL.

#### Step B: Exchange for Tokens

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

### 3. Google Maps Static API Key (Optional)

Enables route map images in daily notes. Without it, activities fall back to an OpenStreetMap text link.

1. Go to https://console.cloud.google.com/
2. Create a new project (or select an existing one)
3. Navigate to **APIs & Services > Library**
4. Search for **Maps Static API** and enable it
5. Go to **APIs & Services > Credentials**
6. Click **Create Credentials > API key**
7. (Recommended) Restrict the key to **Maps Static API** only

The free tier includes 28,000 static map loads per month.

### 4. Import and Configure in Node-RED

1. Import `strava-obsidian-flows.json` via **Menu > Import > Clipboard**
2. Edit the inject nodes (all three flows share the same credential fields):
   - `clientId` — your Client ID
   - `clientSecret` — your Client Secret
   - `refreshToken` — the refresh_token from Step 2B
   - `vaultPath` — path to your Obsidian daily notes folder (e.g., `/kms/10 PMS/11 Daily Notes`)
   - `googleMapsKey` — your Google Maps key (leave as `YOUR_GOOGLE_MAPS_KEY` to use OSM links)
3. On the **Historic** inject node, set `historyYear` to the year you want to load and `replaceMode` to control whether existing entries are overwritten
4. Deploy. Polling starts automatically; historic loading requires a manual click.

## Daily Note Structure

Notes are written to `{vaultPath}/{YYYY}/{MM}/{YYYY-MM-DD}.md`. The flow creates directories as needed. Activities are inserted under a `## Notes` heading — if the heading doesn't exist, it's created. If it does exist, activities are inserted before the next `## ` heading.

## Token Lifecycle

- Access tokens expire every 6 hours
- The flow checks `expiresAt` before each API call
- When expired, it POSTs to `/oauth/token` with the stored refresh token
- Strava may issue a new refresh token in the response — the flow stores this automatically
- The initial `refreshToken` in the inject node is only used on first deploy (before any tokens are persisted)

---

# Garmin to Obsidian

A Node-RED flow (`garmin-obsidian-flows.json`) that fetches wellness data from Garmin Connect and writes it to Obsidian daily notes. Uses the [`garmin-connect`](https://www.npmjs.com/package/garmin-connect) npm package to handle authentication and API calls.

## What's Collected

**Daily wellness entry** (written to yesterday's daily note at 2 AM):

```markdown
- 00:00 😴 Garmin Wellness #garmin
  <!-- garmin-wellness-2026-02-22 -->
	- **Sleep:** 7h 23m | Score: 78 | Deep 1h 45m | REM 1h 48m | Awake 20m
	- **Heart Rate:** Resting 52 bpm
	- **Steps:** 8,432
```

**Weekly cycling summary** (written to Sunday's daily note at 2 AM Monday):

```markdown
- 🚴 Weekly Cycling W08 #garmin
  <!-- garmin-weekly-2026-02-22-W08 -->
	- **Distance:** 124.5 km | **Rides:** 4 | **Elevation:** 1,240 m | **Time:** 4h 32m
```

Resting HR comes from the sleep summary (Garmin includes it there). Body battery and stress are not currently available via the npm library.

## Three Operating Modes

- **Daily at 2 AM** — fetches yesterday's sleep, resting HR, and steps
- **Weekly at 2 AM Monday** — fetches prior week's cycling activities, filters by type, aggregates distance/elevation/time
- **Historic loader** — manual trigger, iterates day-by-day through a full year back-filling wellness data

## Setup

### 1. Install the npm package

```bash
cd /path/to/strava-to-obsidian
npm install
```

This installs `garmin-connect` (and any other dependencies listed in `package.json`).

### 2. Import and configure in Node-RED

1. Import `garmin-obsidian-flows.json` via **Menu > Import > Clipboard**
2. Edit the **Setup (run once)** inject node with:
   - `garminEmail` — your Garmin Connect account email
   - `garminPassword` — your Garmin Connect password
   - `configFilePath` — full path for the credentials file (e.g. `/Users/yourname/.garmin-obsidian.json`)
   - `scriptPath` — full path to `garmin-fetch.js` (e.g. `/Users/yourname/strava-to-obsidian/garmin-fetch.js`)
   - `vaultPath` — path to your Obsidian daily notes folder
   - `garminTimezoneOffset` — your UTC offset in hours (e.g. `11` for AEDT, `-5` for EST)
3. Click the Setup inject — it writes credentials to the config file and stores paths in Node-RED flow context
4. Click the Daily inject to test

### 3. Test from the command line

Before triggering from Node-RED, you can verify the script works directly:

```bash
node garmin-fetch.js --type daily --date 2026-02-22
node garmin-fetch.js --type weekly --weekStart 2026-02-16 --weekEnd 2026-02-22
```

Expected output is a JSON object on stdout. Errors appear on stderr.

## How Authentication Works

The `garmin-connect` library handles Garmin's OAuth-based SSO login. On first run it logs in with email/password and saves a session token to `~/.garmin-session.json`. Subsequent runs restore the cached session (avoiding a full login round-trip). If the session expires, it falls back to a fresh login automatically.

Credentials are stored in `~/.garmin-obsidian.json` (written by the Node-RED setup inject). The session cache is at `~/.garmin-session.json`. Delete the session file to force a re-login.

## What Was Tried First (and Why It Changed)

The original approach tried to call the Garmin Connect API directly from Node-RED HTTP request nodes, mirroring the Strava flow architecture. This ran into several problems:

**Auth complexity** — Garmin's login endpoint (`sso.garmin.com/portal/api/login`) is blocked by Cloudflare bot protection and returns a 403 challenge page when called from a server-side HTTP client. A fallback was implemented to manually paste browser cookies and CSRF tokens from DevTools, but these expire with each browser session.

**Endpoint discovery** — The proxy-based API paths used in documentation (`/proxy/wellness-service/...`) were returning empty `{}` responses. The actual working endpoint for sleep data was found via DevTools to be `/gc-api/sleep-service/sleep/dailySleepData?date=...&nonSleepBufferMinutes=60` — and the auth required the full browser cookie string plus a `connect-csrf-token` header, not just a JWT.

**Fragility** — Even with correct cookies and endpoints, manual cookie rotation is unsustainable for an automated daily flow. The `garmin-connect` npm library handles all of this: it logs in using the official SSO flow (using a browser-like request sequence that passes Cloudflare), manages the OAuth token lifecycle, and exposes clean methods for the data we need.

The switch from ~76 nodes with 7 HTTP request chains to ~46 nodes with 3 exec nodes eliminated all the auth plumbing and endpoint guesswork.

## Historic Loading

Set `historyYear` on the historic inject node to the year you want to load (e.g. `2024`). Click inject. The flow iterates day-by-day, calling `garmin-fetch.js` once per day with a 2-second pause between calls to avoid rate limiting. The `Advance Day` node shows progress in its status field. The HTML comment dedup marker (`<!-- garmin-wellness-YYYY-MM-DD -->`) prevents duplicate entries if you re-run for the same year.

## Files

| File | Purpose |
|------|---------|
| `garmin-obsidian-flows.json` | Node-RED flow — import this |
| `garmin-fetch.js` | Node.js script called by the exec nodes |
| `package.json` | npm dependencies (`garmin-connect`) |
| `~/.garmin-obsidian.json` | Credentials file (written by setup inject, gitignored) |
| `~/.garmin-session.json` | Cached session tokens (auto-managed, safe to delete) |
