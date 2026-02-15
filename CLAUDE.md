# Node-RED Flow Conventions

## File Format
- Single JSON array, directly importable via Node-RED's Import clipboard
- One file per integration (e.g. `strava-obsidian-flows.json`)
- All nodes live under a single `tab` node; the tab's `info` field describes the flow's purpose and setup steps

## Node IDs
- Use readable snake_case IDs, not UUIDs (e.g. `poll_inject`, `historic_build_request`, `link_to_format`)
- Prefix with the flow section: `poll_`, `historic_`, `link_`, `format_`, `build_`, `file_`, `write_`, `refresh_`

## Layout & Structure
- Comment nodes as section dividers: `"── Flow 1: Active Polling ──────────────────────────────"`
- Flows laid out top-to-bottom in Y, left-to-right in X
- Standard Y spacing: ~60px between rows, ~140px between sections
- Standard X spacing: ~180px between nodes in a chain

## Two-Flow Pattern
Every API-to-Obsidian integration has two entry points:
1. **Active Polling** — inject with `repeat: "900"`, `once: true`, `onceDelay: "5"` — polls every 15 min, starts 5s after deploy
2. **Historic Bulk Loading** — inject with `once: false`, manual trigger only — adds a `historyYear` prop

Both share a common Format & Write chain via link nodes.

## Inject Nodes as Configuration
- All user-configurable values go as inject `props` (credentials, `vaultPath`, `historyYear`)
- Placeholder values use `YOUR_` prefix (e.g. `YOUR_CLIENT_ID`)
- Function nodes guard against unconfigured placeholders and `node.warn()` with setup instructions

## State Persistence
- Use `flow.set(key, value, 'file')` / `flow.get(key, 'file')` for state that must survive restarts (tokens, timestamps, pagination cursors)
- Use `flow.set(key, value)` (no `'file'`) for ephemeral config like `clientId`, `vaultPath`

## API Interaction
- Build URL and headers in a function node, then pass to an `http request` node with empty `url` field (reads from `msg.url`)
- Auth headers set via `msg.headers`
- HTTP nodes named after the service (e.g. "Strava API", "Strava OAuth")
- Rate limiting: 1s delay node between pagination pages

## Historic Pagination Loop
```
init_pagination → build_request → http → process_page
                                          ├─ output 1: items → format chain
                                          ├─ output 2: next page → delay(1s) → build_request (loop)
                                          └─ output 3: done/error → debug
```
- Process page is a 3-output function node with labeled outputs
- Loop via delay node back to build_request
- Guard: if `items.length < perPage`, emit done instead of next page

## Format & Write Chain (Shared)
```
link_in ← both flows → format → build_filename → write_queue(rate 1/s) → file_read → insert_into_notes → file_write → debug
```
- **format** node: converts API object to markdown lines, sets `msg.noteupdate`, `msg.dateStr`, `msg.files.dailynotefile`, and a dedup ID field (e.g. `msg.activityId`)
- **build_filename**: `{vaultPath}/{YYYY}/{MM}/{YYYY-MM-DD}.md`
- **write_queue**: `delay` node in rate-limit mode (1 msg/sec) to avoid file write races
- **file_read**: reads existing daily note (file in node, `allProps: true`, `sendError: false`)
- **insert_into_notes**: inserts under `## Notes` heading, creates heading if missing, inserts before next `## ` heading if present
- **file_write**: overwrites file, `createDir: true`
- **Duplicate prevention**: check if the dedup ID string exists anywhere in file content; if so, `return null`

## Markdown Output Style
```markdown
- HH:MM 🗺️ [Title](url) : Category #tag
	- Detail line with **Bold:** values | separated by pipes
	- [Map](https://www.openstreetmap.org/?mlat=LAT&mlon=LNG#map=15/LAT/LNG)
```
- Top-level list item with time, emoji, linked title, type, hashtag
- Sub-items indented with `\t-` (tab + dash)
- Bold keys: `**Distance:** 5.23 km`
- Pipe-separated values within a detail line
- Map link to OpenStreetMap as last sub-item when coordinates available

## Link Nodes
- Use link out/in pairs to connect sections without wire spaghetti
- Name pattern: `→ Target` for link out, `← Source` for link in
- Link IDs referenced in both the `links` array of the link out and the `links` array of the corresponding link in

## OAuth2 Token Refresh (when needed)
- Separate sub-chain connected via link nodes from both polling and historic flows
- `msg._source` ("poll" or "historic") tracks which flow triggered the refresh
- After refresh, a switch node routes back to the correct flow's continuation point
- Tokens stored in file-backed flow context (`accessToken`, `expiresAt`, `refreshToken`)
- Check expiry with 60-second buffer: `now >= expiresAt - 60`
