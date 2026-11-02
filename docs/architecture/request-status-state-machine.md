# Request Status State Machine

How the system determines the current status of media requests by checking multiple data sources in priority order.

## State Machine Overview

```
                                  REQUEST SUBMITTED
                                        │
                                        ▼
                                  ┌──────────┐
                                  │ pending  │
                                  └────┬─────┘
                                       │
                          ┌────────────┼────────────┐
                          │            │            │
                          ▼            ▼            ▼
                   ┌───────────┐ ┌──────────┐  (>2h timeout)
                   │ monitored │ │searching │      │
                   └─────┬─────┘ └────┬─────┘      ▼
                         │            │      ┌─────────────┐
                         │            │      │ unavailable │
                         └──────┬─────┘      └─────────────┘
                                │                   ▲
                                ▼                   │
                          ┌──────────┐              │
                          │  queued  │         (couldn't be added /
                          └────┬─────┘          not available yet)
                               │                    │
                    ┌──────────┼──────────┐         │
                    │          │          │         │
                    ▼          ▼          │         │
             ┌──────────┐ ┌──────────┐   │         │
             │  paused  │ │downloading│───┼─────────┘
             └────┬─────┘ └────┬─────┘   │
                  │            │         │
                  └──────┬─────┘         │
                         │               │
                         ▼               │
                   ┌───────────┐         │
                   │ importing │◄────────┘
                   └─────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │ synching  │
                   └─────┬─────┘
                         │
                         ▼
                   ┌───────────┐
                   │ available │
                   └───────────┘


  Legend:
    paused ⇄ downloading  (bidirectional: pause/resume)
    monitored → searching  (when release date passes)
    Any state → unavailable (on failure/timeout)
```

## Status Values

| Status                                                                          | Meaning | User-Facing |
| ------------------------------------------------------------------------------- | ------- | ----------- |
| The enum VALUES are a public API contract (the Apple apps switch on them) and   |
| stay as they are. The user-facing labels are deliberately neutral: they say the |
| admin is handling the request, never how the title is obtained.                 |

| Status        | Meaning                                                    | User-Facing (en / de)                                                  |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pending`     | Request submitted, awaiting approval/processing            | "Sending request..." / "Anfrage wird gesendet..."                      |
| `searching`   | Accepted by the admin's service, not in its queue yet      | "In progress" / "In Bearbeitung"                                       |
| `monitored`   | Tracked by Radarr/Sonarr, waiting for release or the admin | "Waiting for the admin's service" / "Wartet auf den Dienst des Admins" |
| `queued`      | In the Sonarr/Radarr queue, not started                    | "Queued" / "In Warteschlange"                                          |
| `paused`      | Paused in the Sonarr/Radarr queue                          | "Paused" / "Pausiert"                                                  |
| `downloading` | In progress in the Sonarr/Radarr queue                     | "In progress" / "In Bearbeitung"                                       |
| `importing`   | Radarr/Sonarr is adding the file to the library            | "Being added to the library…" / "Wird zur Bibliothek hinzugefügt…"     |
| `synching`    | File in library, waiting for the scan                      | "Being processed" / "Wird verarbeitet"                                 |
| `available`   | Ready to watch                                             | "Available" / "Verfügbar"                                              |
| `unavailable` | Not available yet, couldn't be added, or not requested     | "Unavailable" / "Nicht verfügbar"                                      |

### Status Priority (for aggregation)

When combining multiple season statuses into one:

```
available (10) > synching (9) > importing (8) > downloading (7) >
paused (6) > queued (5) > searching (4) > monitored (3) >
pending (2) > unavailable (1)
```

---

## Entry Point

**Route:** `POST /api/request/status`

**Request body:**

```json
{
    "requests": [
        {
            "externalIds": { "tmdb": "550", "imdb": "tt0137523" },
            "mediaType": "movie",
            "seasons": [1, 2] // optional, TV only
        }
    ]
}
```

Max 20 requests per batch. Seasons max 50 per request.

### Dispatch Logic

| mediaType | seasons?    | Resolver                             | Returns                    |
| --------- | ----------- | ------------------------------------ | -------------------------- |
| `movie`   | n/a         | `determineMovieStatus()`             | 1 result                   |
| `tv`      | `[1, 2, 3]` | `determineSeasonStatus()` per season | N results (one per season) |
| `tv`      | omitted     | `determineTvAggregateStatus()`       | 1 result                   |

### Data Pre-Fetching

All expensive API calls are made **once** before processing individual requests:

| Data Source                        | How                                   | Shared Across               |
| ---------------------------------- | ------------------------------------- | --------------------------- |
| Sonarr queue (100 records)         | Parallel fetch                        | Season + TV aggregate       |
| Radarr queue (100 records)         | Parallel fetch                        | Movie resolver              |
| Jellyseerr user info               | Parallel fetch                        | Request age calculation     |
| Jellyseerr user requests (last 50) | Sequential (needs user ID)            | Request age calculation     |
| Jellyseerr media info per item     | Parallel batch                        | Title, TVDB ID, MediaStatus |
| Jellyseerr season statuses         | Parallel batch (TV with seasons only) | Season resolver             |
| Radarr movie details               | **Lazy-loaded** (only when needed)    | Movie resolver steps 3-4    |

---

## Movie Resolver

**Function:** `determineMovieStatus()` in `resolvers.ts`

### Step 1: Jellyfin Database (highest priority)

```
Query: media_items + external_ids + library_availability
Condition: la.available = true AND mi.status = 'active'
→ 'available' (with jellyfinId)
```

### Step 2: Radarr Queue

```
Match: record.movie.tmdbId === tmdbId
→ 'queued' | 'paused' | 'downloading' | 'importing'
```

State detection uses `trackedDownloadState`:

- `'importPending'` or `'importing'` → state `'importing'`
- `percentage >= 100` (not paused/queued) → state `'importing'`
- `status === 'paused'` → state `'paused'`
- `status === 'queued'` or `remaining === totalSize` → state `'queued'`
- default → state `'downloading'`

Returns `DownloadProgress` with percentage, timeLeft, size, sizeLeft.

### Step 3: Radarr Monitoring (lazy-loaded)

```
If hasFile:
  → 'synching'
If monitored:
  Future release date?     → 'monitored' ("Verfügbar ab DD. MMMM YYYY")
  TBA/Announced?           → 'monitored' ("Release date not announced yet")
  In cinemas?              → 'monitored' ("In cinemas - waiting for digital release")
  Released:
    > 1 hour old             → 'monitored' ("Waiting for the admin's service")
    Otherwise                → 'searching' ("In progress")
```

### Step 4: Jellyseerr MediaStatus

```
AVAILABLE (5):
  → 'synching' (Jellyseerr says available but Jellyfin doesn't have it)

PROCESSING (3):
  Radarr hasFile?    → 'synching'
  < 10 min old       → 'searching'
  < 1 hour old       → 'searching'
  > 1 hour, monitored → 'monitored' ("Waiting for the admin's service")
  > 1 hour, not monitored → 'unavailable' ("Not available yet")

PENDING (2):
  → 'pending'
```

### Step 5: Default

```
→ 'unavailable'
```

---

## Season Resolver

**Function:** `determineSeasonStatus()` in `resolvers.ts`

Called once per requested season. Shares pre-fetched data with other seasons.

### Step 1: Season Lookup

```
Query: media_items (type='season') JOIN external_ids WHERE tmdb_id AND season_number
→ 'available' (with jellyfinId from external_ids)
```

### Step 2: Sonarr Queue (most reliable)

```
Match: record.series.tvdbId === tvdbId AND record.episode.seasonNumber === seasonNumber
Aggregates across all episodes in the season.
→ 'queued' | 'paused' | 'downloading' | 'importing'
```

Same `trackedDownloadState` detection as movie resolver.

### Step 3: Jellyseerr Season Status

Uses pre-fetched `SeasonRequestStatus` per season.

```
3a. isAvailable = true:
  → 'synching' (Jellyseerr says available but not in Jellyfin)

3b. isRequested + requestStatus string:
  'pending'    → 'pending'
  'processing' → 'searching'
  'approved'   → 'synching'
  'declined'   → 'unavailable'

3c. Numeric status code:
  5 (AVAILABLE)           → 'synching'
  4 (PARTIALLY_AVAILABLE) → 'importing'
  3 (PROCESSING):
    < 10 min → 'searching'
    > 10 min → 'searching' (longer message)
  2 (PENDING)             → 'pending'
```

### Step 4: Default

```
→ 'unavailable'
```

---

## TV Aggregate Resolver

**Function:** `determineTvAggregateStatus()` in `resolvers.ts`

Used when no specific seasons are requested. Returns one status for the entire series.

### Early Return

```
Jellyseerr AVAILABLE → 'available'
```

### Step 1: Sonarr Queue

Same as the season resolver's queue step, but matches across **all episodes**
in the series (not filtered by season).

### Step 2: Sonarr Series Monitoring

```
If hasFile:             → 'synching'
If monitored:
  Future next release   → 'monitored' (with formatted date)
  TBA/Announced         → 'monitored' ("Wartet auf Veröffentlichungsdatum")
  In Cinemas            → 'monitored' ("Derzeit im Kino")
  Upcoming              → 'monitored' ("Serie startet bald")
  Released/Continuing/Ended:
    > 1 hour old          → 'monitored'
```

### Step 3: Jellyseerr PROCESSING

```
> 1 hour, monitored     → 'monitored'
> 1 hour, not monitored → 'unavailable' ("Not available yet")
> 10 minutes            → 'searching'
< 10 minutes            → 'searching' ("Anfrage wird verarbeitet")
```

### Step 4: Jellyseerr PENDING

```
> 2 hours → 'unavailable' ("Verarbeitung fehlgeschlagen")
< 2 hours → 'pending'
```

### Step 5: Default

```
→ 'pending'
```

---

## Download Progress

**File:** `progress.ts`

Extracted from Sonarr/Radarr queue records.

```typescript
interface DownloadProgress {
    percentage: number; // 0-100
    timeLeft?: string; // "00:05:30"
    size?: string; // "4.2 GB"
    sizeLeft?: string; // "1.5 GB"
    state?: 'queued' | 'paused' | 'downloading' | 'importing';
}
```

### State Detection (Radarr/Sonarr)

| Condition                                          | State           |
| -------------------------------------------------- | --------------- |
| `trackedDownloadState === 'importPending'`         | `'importing'`   |
| `trackedDownloadState === 'importing'`             | `'importing'`   |
| `percentage >= 100` (not paused/queued)            | `'importing'`   |
| `status === 'paused'`                              | `'paused'`      |
| `status === 'queued'` or `remaining === totalSize` | `'queued'`      |
| default                                            | `'downloading'` |

### Season Progress Aggregation

For seasons: all episodes in the season are aggregated. Progress is total bytes across all episodes.

For TV aggregate: all episodes in the series are aggregated.

If any episode is paused → `'paused'`. If all queued → `'queued'`. If any importing → `'importing'`.

---

## Jellyseerr Status Codes

### MediaStatus (media-level)

| Code | Name                | Meaning                        |
| ---- | ------------------- | ------------------------------ |
| 1    | UNKNOWN             | Not requested                  |
| 2    | PENDING             | Requested, awaiting processing |
| 3    | PROCESSING          | Approved, being handled        |
| 4    | PARTIALLY_AVAILABLE | Some episodes available (TV)   |
| 5    | AVAILABLE           | Fully available                |

### RequestStatus (request-level)

| Code | Name             |
| ---- | ---------------- |
| 1    | PENDING_APPROVAL |
| 2    | APPROVED         |
| 3    | DECLINED         |

### Season Request Status Strings

| String         | Mapped To       |
| -------------- | --------------- |
| `'pending'`    | `'pending'`     |
| `'processing'` | `'searching'`   |
| `'approved'`   | `'synching'`    |
| `'declined'`   | `'unavailable'` |

---

## Request Age Logic

Calculated from the Jellyseerr request's `createdAt` timestamp. Used for:

| Context                      | Threshold                      | Effect                                 |
| ---------------------------- | ------------------------------ | -------------------------------------- |
| Movie monitoring (released)  | > 1 hour                       | `'monitored'` instead of `'searching'` |
| TV aggregate PROCESSING      | < 10 min / < 1 hour / > 1 hour | Cascading status                       |
| TV aggregate PENDING timeout | > 2 hours                      | `'unavailable'`                        |

---

## Client-Side Behavior

### Web Frontend

- **Polling:** 10s when downloading, 30s otherwise
- **Per-season tracking:** Sends specific season numbers, displays per-season breakdown
- **Dismissals:** Per-season aware (saves seasons array)
- **Auto-removal:** When all seasons available AND watched

### tvOS

- **Polling:** Every 5 seconds via `RequestManager`
- **Terminal states:** Stops polling at `available` or `unavailable`
- **Per-season tracking:** Caches per `compositeKey + seasonNumber`
- **Callbacks:** `onItemBecameAvailable`, `onSeasonBecameAvailable`

### Shared Contract

Both clients use the same API response format:

```json
{
    "externalIds": { "tmdb": "1399" },
    "mediaType": "tv",
    "seasonNumber": 2,
    "status": "downloading",
    "statusMessage": "In Bearbeitung",
    "download": {
        "percentage": 45,
        "timeLeft": "00:05:30",
        "size": "4.2 GB",
        "sizeLeft": "2.3 GB",
        "state": "downloading"
    },
    "jellyfinId": null,
    "watched": false
}
```

---

## File Reference

| File                                                       | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `src/routes/api/request/status/+server.ts`                 | Entry point, orchestration, data pre-fetching |
| `src/lib/server/services/request-status/resolvers.ts`      | Movie, season, TV aggregate resolvers         |
| `src/lib/server/services/request-status/progress.ts`       | Download progress from Radarr/Sonarr queues   |
| `src/lib/server/services/request-status/database.ts`       | Jellyfin availability checks                  |
| `src/lib/server/services/request-status/status-mapping.ts` | Status types, priority, mapping functions     |
| `src/lib/server/services/request-status/types.ts`          | Type definitions                              |
| `src/lib/server/services/request-status/utils.ts`          | Validation, date formatting                   |
| `src/lib/server/jellyseerr.ts`                             | Jellyseerr client, MediaStatus enum           |
