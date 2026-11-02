# Continue Watching Architecture

How Lumastra decides what shows up in the home page's Continue Watching strip,
how Next Up is anchored, and the lifecycle of dismissals and engagement
tracking.

This doc is **strategic** — it answers "how should I think about this?", not
"what does line N do?". For implementation specifics, follow the file:line
links into the code.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Event Sources](#event-sources)
4. [The Rebuilder](#the-rebuilder)
5. [Continue Watching Query](#continue-watching-query)
6. [Next Up Query](#next-up-query)
7. [Custom Episode Orderings](#custom-episode-orderings)
8. [Migration & Suspicion Heuristics](#migration--suspicion-heuristics)
9. [Dismissal Lifecycle](#dismissal-lifecycle)
10. [Live Overlay & Active Sessions](#live-overlay--active-sessions)
11. ["Set My Progress" Escape Hatch](#set-my-progress-escape-hatch)
12. [Failure Modes & How to Reason About Them](#failure-modes--how-to-reason-about-them)
13. [Where to Make Changes](#where-to-make-changes)

---

## Overview

Continue Watching is the home strip of "what should I watch next." It
merges two distinct concepts behind a single user-visible row:

- **Continue Watching (CW)**: items the user _paused_ mid-playback. Has a
  resume position. Surfaces "you're 45% through episode 5; pick up here."
- **Next Up (NU)**: the _next sequential episode_ of a series the user is
  actively watching. No resume position. Surfaces "you finished S2:E10;
  S2:E11 is up next."

Both bind to the same UI surface but have distinct SQL queries with
different anchor logic. They're merged at the service layer, not in the
database.

```
                        Home page CW strip
                                |
                +---------------+----------------+
                |                                |
                v                                v
    +---------------------+         +-----------------------+
    | Continue Watching   |         |       Next Up         |
    | (paused mid-play)   |         | (next episode after   |
    |                     |         |  most-recent watched) |
    | resume_position_ms  |         |                       |
    | > 0                 |         | resume_position_ms = 0|
    +----------+----------+         +-----------+-----------+
               |                                |
               +-------------+------------------+
                             |
                             v
                +---------------------------+
                | effective-watching service|
                | (merge, dedupe, overlay)  |
                +---------------------------+
                             |
                             v
                       Home strip JSON
```

The whole pipeline is **event-sourced**: `user_media_events` is the log,
`user_media_state` is the materialized view, and the rebuilder is the
projector.

---

## Playback engagement gate

Live video heartbeat/stop and video/audiobook offline-upload writers use `engagementThresholdMs` in
`src/lib/server/utils/watch-constants.ts` before persisting resume progress:
`min(60 seconds, 25% of runtime)` for a known positive runtime, otherwise 60 seconds.
Combined multi-episode files use the opened episode's window duration. For example,
40 seconds of a 145-second episode passes the 36.25-second gate; 40 seconds of a
20-minute episode stays below the unchanged 60-second gate.

Stops and offline records retain their completion exceptions (past the completion
threshold or an explicit completion end). Music and live audiobook reports use separate listening paths;
audiobook completion retains its existing rules. Provider syncs and explicit user
watch-state actions bypass this playback engagement gate.

## Data Model

Three tables hold the durable state.

**`user_media_events`** — append-only log of everything that's ever
happened to a user/media pair. Each row is one event:

| Column                    | Meaning                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `event_type`              | `progress` \| `mark_watched` \| `mark_unwatched` \| `completed` |
| `source`                  | Who emitted this (see [Event Sources](#event-sources))          |
| `position_ms`             | Playback position at event time (null for marks)                |
| `runtime_ms`              | Media runtime if known                                          |
| `occurred_at`             | Wall-clock when the event happened (NOT when ingested)          |
| `session_id`, `event_seq` | Lumastra-player heartbeat ordering                              |
| `source_event_id`         | Foreign-side ID for dedup                                       |

**`user_media_state`** — projected view, one row per (user, media). Every
read of CW or NU goes through this table, never the events log directly:

| Column                      | Meaning                                    |
| --------------------------- | ------------------------------------------ |
| `is_watched`                | The user-visible boolean                   |
| `resume_position_ms`        | Where to resume; 0 means clean             |
| `last_watched_at`           | Most recent positive event's `occurred_at` |
| `first_watched_at`          | Earliest positive event's `occurred_at`    |
| `last_event_at`             | Most recent event of _any_ kind            |
| `last_event_source`         | Source that drove the current `is_watched` |
| `is_watched_source`         | Same; preserved across compaction          |
| `runtime_ms`, `watch_count` | Maintenance fields                         |

**`user_media_state_snapshot`** — periodic snapshots used for log
compaction. The rebuilder writes a snapshot after every N events
(`COMPACTION_THRESHOLD = 100`) so state rebuilds stay bounded; older
events can be deleted because the snapshot represents them.

The split between `last_watched_at` and `last_event_at` is load-bearing:

- `last_watched_at` is the timestamp of the most recent **positive**
  event. A `mark_unwatched` doesn't advance it. NU's anchor uses this.
- `last_event_at` advances on **every** event (positive, negative,
  progress). CW's "is this row recent enough to surface" filter uses
  this. The re-watch detection (CW surfacing an `is_watched=true` row
  when fresh activity > prior completion) compares `last_event_at >
last_watched_at`.

The split exists because re-watching a finished series should keep
showing it in CW, but a stale `mark_unwatched` from background sync
shouldn't promote it.

---

## Event Sources

Every event carries a `source`. Sources differ in trust, semantics, and
priority.

| Source               | Origin                                                | Emits                                                            | Notes                                                               |
| -------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `lumastra-player`    | Live heartbeats from the player                       | `progress`, sometimes `completed`                                | Highest fidelity. Carries `session_id`, `event_seq`, `position_ms`. |
| `lumastra-user-mark` | Explicit user-mark UI clicks                          | `mark_watched`, `mark_unwatched`                                 | Decisive. No position.                                              |
| `jellyfin-sync`      | Watch-state-pull plugin reading Jellyfin's `UserData` | `mark_watched`, `mark_unwatched`, `progress` (never `completed`) | Position is Jellyfin's resume bookmark, not live cursor.            |
| `migration`          | One-time M0 backfill from legacy `user_watch_state`   | `mark_watched`, `mark_unwatched`                                 | Bulk import. Wall-clock-tied. Special handling everywhere.          |
| `compaction`         | Internal snapshot rewrites                            | `mark_watched`, `mark_unwatched` (synthetic)                     | Priority 0. Should never affect engagement decisions.               |
| `plex-sync`          | Stub for future Plex integration                      | —                                                                | Not emitting today.                                                 |

**Source priority** governs `is_watched` arbitration when events from
different sources disagree. Higher priority normally wins
(see `SOURCE_PRIORITY` in `watch-state-rebuilder.service.ts`):

```
  lumastra-user-mark (100) > lumastra-player / lumastra-offline (90) >
  jellyfin-sync / plex-sync / mal-sync / trakt-sync / audiobookshelf-sync (10) >
  migration (5) > compaction (0)
```

Concretely: a lumastra-user-mark `mark_watched` from yesterday beats a
jellyfin-sync `mark_unwatched` from today. The user's deliberate click
is more authoritative than what Jellyfin's UserData currently says. The reverse
also applies while the local reset is unacknowledged: an explicit local
`mark_unwatched` beats a later Jellyfin `Played=true`. After Jellyfin acknowledges
the reset, a strictly later upstream LastPlayedDate is a new watch and wins;
earlier/equal echoes keep local priority. The imported count/date can change while `is_watched` stays false;
counts are playback history, not the winning watched verdict. Pull task results
report `totalLostArbitration` and a bounded `arbitrationLosses` sample explaining
which source won, including on repeated unchanged pulls.

Occurrence time orders decisive events **within one source**; it is not a
universal last-write-wins policy. Equal-priority decisive sources use their stable
source-name ordering. The deliberate exception is a strictly newer **live**
`lumastra-player` completion after a local unwatch without a position: finishing
playback in Lumastra can mark it watched again. Offline uploads do not have that
exception. Jellyfin's separate acknowledgement rule is described below.

Outbound progress from both live playback and offline uploads uses Jellyfin's
UserData bookmark setter (`PlaybackPositionTicks = positionMs * 10,000`) without
changing `Played`. It uses the same metadata/file ID resolution as explicit
played/unplayed pushes. An unresolved item, missing user mapping, failed HTTP
write, or missing per-item acknowledgement stays queued with a diagnostic reason;
per-run exclusions let later queue pages proceed. A progress push counts as
successful only after acknowledgement, rather than being reported as a skip.
Jellyfin 10.9+ provides this arbitrary-user setter. Jellyfin 10.8 lacks it; its
playback-report routes bind to the authenticated session even when a different
user is supplied in the URL. With the integration's admin API key, unsupported
bookmark writes are reported as failures and retained, rather than sent to the
wrong user or silently consumed.

**`session_elapsed_ms`** is populated only by `lumastra-player` (it's the
cumulative play time inside one session). Other sources have no
equivalent — Jellyfin's pull tells us a position changed but not how
much was played to get there. This asymmetry matters for the dismissal
auto-clear gate; see [Dismissal Lifecycle](#dismissal-lifecycle).

---

## The Rebuilder

`appendEventAndRebuild` (`watch-state-rebuilder.service.ts`) is the
canonical write path. Every event goes through it. The shape:

```
appendEventAndRebuild(sql, event)
  1. Stale-tab guard         (lumastra-player progress only)
  2. INSERT into events log
  3. Rebuild state row       (rebuildStateFromEvents)
  4. Maybe compact           (snapshot write if N events since last snapshot)
  5. maybeClearDismissalOnEngagement   (auto-clear hide on engagement)
  6. Maybe enqueue immediate watch-sync push (mark_* from Lumastra)
```

Steps 5 and 6 are _post-rebuild_ side effects. They read the new state,
they don't change it. A failure in either is logged and swallowed —
they're best-effort, the user-facing write has already succeeded by
that point.

`rebuildStateFromEvents` is the projector. It walks events from the
last snapshot forward and computes:

1. **`is_watched`**: latest decisive event (mark/completed) from the
   highest-priority source. A newer decisive event from a lower-priority
   source cannot override that verdict; the live-completion exception above
   is handled explicitly.
2. **`resume_position_ms`**: scans events DESC for the most recent
   `progress` event from the source that won `is_watched` arbitration;
   stops at any decisive event from that same source.
3. **`last_watched_at`**: most recent positive event's `occurred_at`,
   subject to the chronology gate (older events can't supersede the
   snapshot's stored value).
4. **`first_watched_at`**: earliest positive event's `occurred_at`.
5. **`last_event_at` / `last_event_source`**: most recent event of any
   kind.

The chronology gate — "events older than the snapshot's `occurred_at`
are historical context, not new state" — exists because back-dated
events from `migration` or out-of-order Jellyfin pulls would otherwise
revoke fresher decisions.

---

## Continue Watching Query

Defined as `getContinueWatchingFromDb` in
`src/lib/server/database/queries/watch-state.queries.ts`.

Returns rows where the user has unfinished business with a media item.
Three core conditions for inclusion (in the base CTE):

1. `is_watched = false AND resume_position_ms > 0` — paused mid-play.
2. `is_watched = true AND last_event_at > last_watched_at` — re-watch
   detection: a previously completed item with fresh activity past the
   prior completion.
3. `last_event_at >= NOW() - maxAgeDays days` — staleness cutoff.

Items pass condition (1) OR (2), AND must pass (3). Default
`maxAgeDays` is configured server-side; rows outside the window drop
out so abandoned content doesn't linger.

**Suppression filter** (added April 2026): a paused row drops out if a
_later_ episode in the same series has been completed _after_ this
row's `last_event_at`. Translation: "if you watched S2:E5 yesterday
and S2:E3 has been paused since last week, drop the S2:E3 row." The
user has clearly moved on.

The query JOINs `user_media_state` to `media_items` (and parents for
series rows), excludes dismissed items via `user_media_flags
LEFT JOIN`, applies the migration-deprioritization tiebreak (see
[Migration & Suspicion Heuristics](#migration--suspicion-heuristics)),
and computes `sort_date` for client-side ordering.

The return row shape (`ContinueWatchingRow`) carries everything the
home strip needs: media identity, title/poster references, resume
position, runtime, the parent series for grouping, suspicion flag,
sort key, etc.

---

## Next Up Query

Defined as `getNextUpFromDb` (and a per-series variant
`getNextUpForSeriesFromDb`) in the same file.

Conceptually: for each series the user is engaged with, find the
_next sequential episode_ after their most recently watched one.

The pipeline is three CTEs:

1. **`eligible_series`** — drop series whose only watched episodes
   came from `migration`. A user with bulk-imported "I watched all of
   S1" but no real engagement events shouldn't get NU pushed at them.
   Implemented via `HAVING bool_or(source <> 'migration')`.

2. **`watched_per_series`** — for each eligible series, pick the
   anchor episode. `DISTINCT ON (series_id)` ordered by:
    1. **Migration-deprioritization CASE**: rows where source =
       `migration` AND ≥ 3 siblings share the same `last_watched_at`
       sort _after_ non-migration rows. The 3-sibling-tie pattern is
       the bulk-import wall-clock signature; real Jellyfin per-row
       timestamps don't tie at sub-second resolution.
    2. `last_watched_at DESC NULLS LAST` — most recent wins.
    3. `effective_order DESC` — tiebreak picks the highest order
       within the same `last_watched_at`. Falling back to "highest"
       preserves the prior "max-watched" behavior for migration-only
       series, where every row ties on `last_watched_at`.

3. **`next_episodes`** — for each anchor, find the first sequential
   episode whose `effective_order > anchor_order`. Filtered to: - Exclude specials (`COALESCE(eo.order_season_number,
mi.season_number) > 0`) - Exclude pre-aired stubs and orphans (`has_files = true OR has
jellyfin_id`) - Exclude ordering-unmapped segments when a custom ordering is
   active

The anchor's tiebreak — order DESC instead of order ASC — is
deliberate. For migration-only series where every row's
`last_watched_at` ties, picking the highest order means "the user has
watched at least up to this episode," and NU points at the next one.
Picking the lowest would underestimate progress. See [Migration &
Suspicion Heuristics](#migration--suspicion-heuristics) for the
broader story.

`getNextUpForSeriesFromDb` is the per-series variant used by
`/watch/[seriesId]` and `/api/series/[id]/next-episode`. Same anchor
model, scoped to one series, with an additional migration filter so a
migration-only series falls back to a deterministic "first episode"
result instead of nothing.

---

## Custom Episode Orderings

Series can have custom episode orderings active (e.g., release order
vs. chronological order; anime alternate orders). When active, the
user's "current episode" depends on the ordering.

The `episode_orderings` + `series_episode_ordering` tables hold
remappings. `buildAutoEpisodeOrderingJoinFragment` is the SQL
fragment every CW/NU query uses to LEFT JOIN the ordering, after
which `COALESCE(eo.order_season_number, mi.season_number)` gives the
effective season for ordering purposes.

The effective order key is:

```sql
COALESCE(eo.order_season_number, mi.season_number)
  * EPISODE_ORDER_MULTIPLIER  -- 10000
+ COALESCE(eo.order_episode_number, mi.episode_number)
```

A single integer that sorts correctly. With multiplier 10000, S3:E2 →
30002 and S2:E15 → 20015; S3:E2 > S2:E15 because 30002 > 20015.

Anchor selection and next-episode resolution both run in effective
order. Pre-aired stubs ordered into a custom timeline still get
filtered out via the `has_files OR jellyfin_id` gate.

When an ordering is active, **unmapped episodes** (rows in
`media_items` that don't appear in `episode_orderings` for the
active ordering) are excluded from CW/NU. The user's main-line
viewing follows the ordering; an unmapped special doesn't anchor or
appear as next.

The "Set my progress" picker uses the same effective ordering for its
through-episode mode, so a re-ordered series splits at the
user-visible boundary, not the stored numbers.

---

## Migration & Suspicion Heuristics

The migration backfill (M0, ~April 2026) imported the legacy
`user_watch_state` table into the new event-sourced model. For users
who pre-dated the rewrite, this populated `user_media_state` with
synthetic events sourced as `migration`.

The migration's data quality is uneven:

- Most rows lost their original timestamps and fell back to a single
  wall-clock (e.g., `2026-04-01 09:46`).
- Many series got "I watched S1 entirely" stamped at one instant,
  with no per-episode chronology.
- Some Jellyfin sync data from the same user is interleaved at
  different timestamps (real engagement before/after migration).

This poisons two natural assumptions:

1. **"Most-recent watched anchors NU"**. With 25 episodes tied on the
   same wall-clock, ordinary `MAX(last_watched_at)` arbitrarily picks
   one; the order-DESC tiebreak picks the highest, which is at least
   stable. But a real Jellyfin-sync row from before migration ran
   could lose to the migration's freshly-stamped batch on
   `last_watched_at` ordering alone — because migration's
   `occurred_at` is "today" while Jellyfin's is the real date months
   prior. Hence the migration-deprioritization CASE: bulk-tied
   migration rows sort _after_ non-migration rows of any age.

2. **"Real engagement post-anchor"**. With migration data populating
   most of `user_media_state`, the eligibility filter `bool_or(source
<> 'migration')` exists so a migration-only series doesn't
   permanently anchor on a stale wall-clock.

**Suspicion** is a related concept — surfaced as `isSuspicious` on
CW rows. It flags rows where the surrounding pattern looks like
bulk-import contamination (e.g., 3+ episodes tied on wall-clock with
`migration` source). The flag is a UI hint for "this might be wrong;
the user might want to correct it." It does not change SQL behavior
otherwise.

The "Set my progress" picker (Phase 3) is the user-facing escape
hatch when no amount of SQL heuristics can fix the drift — see
[that section](#set-my-progress-escape-hatch).

---

## Dismissal Lifecycle

Users can hide a series or movie from CW via the right-click menu
("Hide from Continue Watching"). The flag is stored in
`user_media_flags` with `flag_type = 'dismissed_cw'`.

### Set

`POST /api/continue-watching/dismissals` writes the flag. Idempotent
(`ON CONFLICT DO NOTHING`) so retries don't bump `created_at`.

For episodes, the dismissal target is the **series** (resolved via
`resolveDismissalTarget`); for movies, the movie itself. There's no
per-episode hide.

### Read

CW and NU queries LEFT JOIN `user_media_flags` and exclude rows where
a `dismissed_cw` flag exists for the target. Implemented via
`getActiveFlagTargets` so callers don't need to repeat the
"active = expires_at IS NULL OR expires_at > NOW()" predicate.

### Auto-clear (the interesting part)

`maybeClearDismissalOnEngagement` (in
`watch-state-rebuilder.service.ts`) runs after every event append.
It removes the dismissal flag when the user re-engages with hidden
media — "I started watching this again" overrides "I dismissed it."

The gate has three parts:

1. **Source admission**: `lumastra-player`, `lumastra-user-mark`,
   `jellyfin-sync`. Migration and compaction are excluded by name.
2. **Event-shape filter**: `progress`, `mark_watched`, or
   `completed`. `mark_unwatched` is not engagement.
3. **Zero-position sync exception**: `jellyfin-sync` `progress`
   events with `position_ms = 0` are excluded. The watch-sync engine
   emits these when Jellyfin's resume position vanishes (curPos > 0
   → 0); that's "Jellyfin dropped the resume," not "user is watching
   from the start."

When the gate passes, the helper does a cheap `userHasAnyFlag` probe
(skip the per-event resolveDismissalTarget+delete round-trips when
the user has zero dismissals — common case), then calls
`removeFlagIfOlderThan(target, event.occurred_at)` which only
deletes the flag when `created_at < occurred_at`.

The `created_at < occurred_at` strict-less guard is the safety net
against backfill pulls catching up to _pre-hide_ activity. A
Jellyfin pull running today might surface a play from last month
that pre-dates the hide; without the guard it would falsely undo
the dismiss.

The strict-less form (vs strict-greater-or-equal) keeps a
just-created hide alive on millisecond ties — user intent wins
on ambiguity.

### Re-hide cycles

The lifecycle cleanly handles repeat cycles because the auto-clear
runs **synchronously** inside `appendEventAndRebuild`:

```
T1: hide              → flag(created_at=T1)
T2: watch             → engagement event ingested → rebuilder runs →
                        auto-clear deletes flag (T1 < T2)
T3: re-hide (UI POST) → setFlag finds NO existing row → INSERT
                        creates fresh flag(created_at=T3)
T4: watch again       → flag(T3) deleted (T3 < T4)
```

`setFlag`'s `ON CONFLICT DO NOTHING` is correct for idempotent
retries. The earlier `refreshOnConflict: true` variant (briefly
shipped, reverted) made retries stateful in a way that broke this
contract; see commit `14416beaf` for the details.

### What auto-clear deliberately does NOT handle

- **Multi-user shared Jellyfin accounts**: if two Lumastra users map
  to the same Jellyfin account, one user's playback can clear the
  other user's hide. Out of scope; per-user flag semantics are
  correct, the upstream account mapping isn't.
- **Jellyfin clock skew**: if Jellyfin's clock is meaningfully ahead
  of Postgres's, a pre-hide play could be timestamped post-hide and
  spoof the guard. Self-hosted NTP usually keeps this sub-second.
- **"Mark season watched" in Jellyfin web UI**: emits N
  `mark_watched` events, all with `occurred_at = LastPlayedDate`.
  These pass the gate (it's a deliberate user action even if it's
  cleanup, not real watching). The user can re-hide if they didn't
  mean it.

---

## Live Overlay & Active Sessions

The CW strip on the home page is enriched with **live session data**
before being returned. Implemented in `effective-watching.service.ts`

- `live-watching-overlay.ts`.

The flow:

1. Fetch CW rows + NU rows from the rebuilder-projected DB state.
2. In parallel, fetch any **active** play sessions for the user
   (sessions still emitting heartbeats).
3. The overlay merges:
    - For sessions matching an existing CW row, replace the row's
      `resume_position_ms` and `updatedAt` with the live values.
    - For sessions on items NOT yet in CW (user just hit play 30s
      ago, no rebuild has run yet), synthesize a CW row.
    - Drop CW rows representing items the user finished mid-session
      (live `is_watched=true` overrides durable `is_watched=false`).
4. Apply suspicion annotation, smart-sort, dedup, slice to limit.

The home page's `+page.server.ts` runs this with a **50ms hard
budget** (`WATCHING_SSR_OVERLAY_BUDGET_MS`). On timeout, it returns
durable state and signals `liveOverlayApplied: false`; the client
fires a catch-up fetch after hydration. The budget exists because a
slow active-sessions read shouldn't block the home page render.

The overlay does NOT mutate `user_media_state`. Live data is purely
read-side enrichment.

---

## "Set My Progress" Escape Hatch

When Lumastra's view of a series diverges from the user's mental
model in ways no SQL heuristic can fix (drift from sparse migration
data, incorrect Jellyfin records, watching outside both clients),
the user can manually correct it.

Defined at:

- `POST /api/watched/series/[seriesId]/set-progress`
- `watchManager.setSeriesProgress(...)` service method
- `SetSeriesProgressModal.svelte` UI

Two modes:

- **Through-episode**: linear "I'm at S3:E5". Server marks every
  episode in effective order ≤ the picked one as watched, > as
  unwatched. Common case for forward-only progress that drifted.
- **Per-episode**: explicit `{ watchedIds, unwatchedIds }` for
  non-linear viewing (anthologies, filler-skipping).

Both modes commit as a **delta** against current `is_watched`
state. Episodes whose state isn't changing produce no events.
This avoids `last_watched_at` getting bumped to "now" on no-op
toggles, which would scramble the NU anchor.

Series-level `is_watched` follows the **final** state: full
mark_watched only when every episode ends up watched, else
mark_unwatched. The modal badge ("✓ Watched") reflects the
true state, not just intent.

The picker is reachable from:

- Right-click menu on any CW/NU card → "Set progress…"
- Hover popover above the watched button on series modals (desktop)
- Inside the bulk-mark confirmation dialog (escape hatch)

---

## Failure Modes & How to Reason About Them

When a user reports "the wrong episode is showing in my CW," the
diagnostic order is:

1. **Is it CW or NU?**
    - CW row carries `resume_position_ms > 0` — the user paused there.
      If wrong, ask: "did you actually pause there?" Their `progress`
      event was real. Fix is editing `user_media_state` directly OR
      using the player's "mark unwatched" to clear it.
    - NU row carries `resume_position_ms = 0` and a label like "Next
      episode · S3:E04." If wrong, the _anchor_ is wrong; check
      `watched_per_series` for that user/series.

2. **Is the anchor correct?**
   Run the `watched_per_series` CTE manually for the user against the
   suspect series. The DISTINCT ON winner is the anchor. If it's not
   what the user expects:
    - Migration rows tied on a wall-clock? The order-DESC tiebreak
      picks highest. Acceptable but might surprise.
    - Real Jellyfin rows being deprioritized below migration? Check
      the migration-deprioritization CASE — bulk siblings (≥3 ties)
      get sorted after.
    - Stale `last_watched_at` on a row the user thinks is fresh?
      Check the events log — what's the actual most recent event?

3. **Is the data wrong vs the logic wrong?**
   Often the answer is "Lumastra's data faithfully reflects what
   Jellyfin says, but Jellyfin is wrong." A fresh Jellyfin pull
   (admin "Refresh Watch State" button) wouldn't help because
   Jellyfin's UserData is the same data. The fix is "Set my
   progress" or marking it correctly in Jellyfin and re-pulling.

4. **Is this the user's first time on this version of Lumastra?**
   Their data might be migration-poisoned. Check
   `last_event_source` distribution per series — if it's all
   `migration` with one wall-clock, that's the failure mode the
   "Set my progress" escape hatch is for.

Common drift patterns:

| Symptom                                     | Likely cause                                                                                               | Fix                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Right episode in modal, wrong in CW         | Live overlay disagrees with durable state                                                                  | Wait for rebuild OR force-refresh                 |
| Series stuck hidden after Jellyfin watch    | Pre-`14416beaf` deploy (auto-clear was Lumastra-only) OR clock skew                                        | Already fixed; verify deploy                      |
| Wrong NU anchor, recent Jellyfin sync data  | Migration deprioritization picking older real data over fresher migration ties                             | Working as intended; user can correct via picker  |
| Series in CW that user finished             | Re-watch detection (`last_event_at > last_watched_at`) fired on a stale heartbeat                          | Mark watched via Lumastra to bump both timestamps |
| NU surfaces an episode user already watched | NU dropped the "exclude already-watched" filter after `eee7c5a98` to support re-watches; this is the trade | Working as intended for the re-watch case         |

---

## Jellyfin delivery and file inventory

`jellyfin-file-inventory` runs separately every five minutes, with a 30-minute
budget and a singleton guard. Complete inventories refresh at most every 30
minutes for existing file links or unresolved titles with matching evidence.
Known one-sided titles do not trigger that cadence; negative discovery is reused
until the local file fingerprint changes, an unknown upstream item arrives, or
six hours pass. Push and pull only compare cached evidence; inventory HTTP can
never consume their five-minute execution window.

Missing local mounts/disabled paths and missing remote IDs both require two
complete inventories before deleting a file link. A present file with a changed
path or size invalidates the link immediately on comparison. A recreated remote
ID can therefore take 30–60 minutes to replace the old link. Different relative
folder layouts require matching public provider IDs. Multiple remote versions sharing one public ID can pair only when a unique
known-size file match distinguishes the version and every shared ID agrees on
the single local owner. Ambiguous versions remain unpaired.

Jellyfin movie/episode delivery failures and missing resolutions keep the events
queued with durable per-event/provider attempt counts, last reasons, and next
attempt timestamps. Delays double from ten minutes up to one day. Only the first
actual failure makes the push task fail; later retries remain visible under
Connections without making every scheduled run red. Missing resolutions are
skips throughout. New local events bypass old delays, and new file pairings and
manual exports clear the delay. Other providers drain missing IDs once; ABS only
accepts audiobook watch targets. Benign terminal drains are skips.

Successful decisive writes atomically record their acknowledgement clock, also
carrying it into any snapshot of that reset. A strictly later Jellyfin Played
report with its own LastPlayedDate can override an acknowledged local unwatch;
an unacknowledged reset or an earlier/equal echo keeps local priority. A report
without LastPlayedDate cannot release that protection. Older delivery markers
have no reliable clock; migration time is their conservative acknowledgement
fence. Progress-only writes preserve Played, so a played item can retain a
bookmark. UserData writes prefer the current UserItems route and use the legacy
alias only after a 404/405. Inventories request an Id tiebreak where supported;
older servers rejecting that enum retain count/duplicate drift detection and a
whole-snapshot retry.

---

## Where to Make Changes

| You want to...                    | Touch this                                                                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a new event source            | `user-media-events.queries.ts` (EventSource union), `SOURCE_PRIORITY` in rebuilder, source-admission gate in `maybeClearDismissalOnEngagement` if engagement-class |
| Change CW eligibility             | `getContinueWatchingFromDb` base CTE — be ready to walk every concern: re-watch, paused, suppression, dismissal exclusion, age cutoff                              |
| Change NU anchor selection        | `watched_per_series` CTE in `getNextUpFromDb`. Read [Migration & Suspicion Heuristics](#migration--suspicion-heuristics) first; the tiebreaks are load-bearing     |
| Change dismissal semantics        | `maybeClearDismissalOnEngagement` for auto-clear; `setFlag` for write semantics; read [Dismissal Lifecycle](#dismissal-lifecycle)                                  |
| Add a new flag type               | `user-media-flags.queries.ts` (`FlagType` union, CHECK constraint migration), then decide if it needs auto-clear logic                                             |
| Change live overlay behavior      | `live-watching-overlay.ts`. The 50ms SSR budget is intentional — don't add expensive work without raising it                                                       |
| Add a UI surface that displays CW | Use `effective-watching.service.ts` (`effectiveWatchingFor`), not raw `getContinueWatching` — you need overlay + dedup + sort                                      |
| Change "Set my progress" behavior | `watchManager.setSeriesProgress` for both modes; delta-based commit semantics are essential, don't bypass them                                                     |

When in doubt: most CW/NU bugs are **data problems**, not logic
problems. The query surface is well-tested; the inputs (event source
mix, custom orderings, Jellyfin's UserData accuracy) are where
weirdness lives. Investigate the data first.

---

## Related Reading

- [Playback decisions](https://lumastra.org/architecture/playback-decisions/) — playback
  flow, player events, watch-state recording
- `docs/architecture/database-architecture.md` — the three-tier DB
  pattern (queries / services / managers)
- `CLAUDE.md` (repo root) — provider-agnostic patterns and critical
  gotchas across the whole codebase
