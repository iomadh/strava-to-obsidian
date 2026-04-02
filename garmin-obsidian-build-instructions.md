# Garmin → Obsidian Activity Notes: Build Instructions

## Overview

Build a sync tool that pulls activity data from the Garmin Connect API and writes it into an Obsidian vault as individual markdown notes — one note per activity. The goal is a clean Obsidian Bases-compatible table view of all activities, without polluting daily notes with large property blocks.

---

## Vault Path

The Obsidian vault root is: `/kms/10 PMS/`

All paths below are relative to this root.

---

## Folder Structure

Create the following structure inside the Obsidian vault:

```
/kms/10 PMS/
├── Activities/
│   ├── _ActivityLog.md          ← Bases view lives here (static file, create once)
│   └── 2026/
│       └── 03/
│           ├── 20260320-ride-two-bridges-north-berwick.md
│           ├── 20260317-ride-to-the-craigs-for-scouts.md
│           └── 20260305-ride-fly-you-fools.md
└── Daily Notes/
    └── 2026-03-20.md            ← links to activities only, no bulk properties
```

- Organise activity notes by `Activities/YYYY/MM/`
- Filename format: `YYYYMMDD-<sport_type_lowercase>-<slugified-activity-name>.md`
- The `_ActivityLog.md` file is a static placeholder where the Bases view is configured — do not overwrite it on sync

---

## Activity Note Format

Each activity note should have the following YAML frontmatter. Map Garmin API fields to these property names exactly, as Obsidian Bases will use them as column headers.

```yaml
---
activity_id: 1774900331834
date: 2026-03-20
type: Ride
sport_type: Ride
gear: Elan Ti
name: Two bridges and north Berwick
dist_km: 185.95
elv_m: 1319
elapsed_time: "09:32:44"
moving_time: "08:34:40"
start_time: "09:07:34"
day_of_week: Friday
speed_kmh: 21.7
max_speed_kmh: 57.7
---
```

The note body should contain only a link back to Garmin Connect:

```markdown
[View on Garmin Connect](https://connect.garmin.com/activity/1774900331834)
```

### Property Notes

| Property | Type | Notes |
|---|---|---|
| `activity_id` | integer | Garmin's unique activity ID — used for dedup |
| `date` | YYYY-MM-DD | Date of activity, used for Bases sorting |
| `type` | string | e.g. Ride, Run, Walk |
| `sport_type` | string | Garmin sub-type |
| `gear` | string | Gear/bike name from Garmin |
| `name` | string | Activity name as set in Garmin Connect |
| `dist_km` | float | Distance in kilometres |
| `elv_m` | integer | Elevation gain in metres |
| `elapsed_time` | string | Total elapsed time HH:MM:SS |
| `moving_time` | string | Moving time HH:MM:SS |
| `start_time` | string | Local start time HH:MM:SS |
| `day_of_week` | string | e.g. Monday, Friday |
| `speed_kmh` | float | Average speed km/h |
| `max_speed_kmh` | float | Max speed km/h |

---

## Sync Logic

### Deduplication

Before writing a note, check whether a file with the same `activity_id` already exists anywhere under `Activities/`. If it does, skip it (or optionally update it if a `--force` flag is passed). Do not rely on filename alone — search frontmatter for `activity_id`.

### Date Derivation

- `date`: parse from Garmin's activity start timestamp, converted to local time
- `day_of_week`: derive from `date` (do not pull from Garmin API)
- `elapsed_time` / `moving_time` / `start_time`: format as `HH:MM:SS` strings

### Slug Generation

Slugify the activity name for the filename:
- Lowercase
- Replace spaces and special characters with hyphens
- Strip punctuation (e.g. `Fly, you fools!` → `fly-you-fools`)
- Truncate to 50 characters max

### Gear Lookup

Garmin returns a gear ID, not a name. Perform a separate lookup to resolve the gear name before writing the note.

---

## Daily Note Integration

Do not write activity properties into the daily note. Instead, append a link section to the daily note for any activities that occurred on that date:

```markdown
## Activities
- [[Activities/2026/03/20260320-ride-two-bridges-north-berwick|Two bridges and north Berwick]]
```

Only add this section if it doesn't already exist in the daily note. Do not duplicate links on re-sync.

---

## Obsidian Bases Configuration (`_ActivityLog.md`)

Create this file once. It is not managed by the sync script after initial creation.

```markdown
---
bases:
  source: Activities
  filter:
    activity_id: { exists: true }
  sort:
    - date: desc
  columns:
    - date
    - name
    - type
    - gear
    - dist_km
    - elv_m
    - moving_time
    - speed_kmh
    - max_speed_kmh
---
```

---

## Garmin API Field Mapping

| Obsidian Property | Garmin API Field |
|---|---|
| `activity_id` | `activityId` |
| `date` | `startTimeLocal` (date part) |
| `name` | `activityName` |
| `type` | `activityType.parentTypeId` (resolved to label) |
| `sport_type` | `activityType.typeKey` |
| `dist_km` | `distance` ÷ 1000 |
| `elv_m` | `elevationGain` |
| `elapsed_time` | `duration` (seconds → HH:MM:SS) |
| `moving_time` | `movingDuration` (seconds → HH:MM:SS) |
| `start_time` | `startTimeLocal` (time part) |
| `speed_kmh` | `averageSpeed` × 3.6 |
| `max_speed_kmh` | `maxSpeed` × 3.6 |
| `gear` | resolve via gear ID lookup |

---

## Out of Scope

- Authentication / OAuth flow setup (assumed to be handled externally)
- Garmin API pagination (implement standard pagination but no special handling required)
- Historical backfill beyond what the Garmin API returns by default
- The Bases view UI itself (configured manually in Obsidian after files are created)
