# User Events and Notifications

What the per-user event system should be, decided from the product rather than from the list
that happens to be in `ADVERTISED_EVENT_TYPES` today.

This supersedes the **Notifications** section of `social-sharing.md`, which stated the three
defects but not what the system is for. The sizing bands in that document apply here
unchanged: 1–100 users, the admin knows everyone personally, no fan-out scale problem.

## The correction that motivates this

Commit `a0992a5f8` pruned `ADVERTISED_EVENT_TYPES` from eleven kinds to four, on the grounds
that seven had no emitter anywhere. That was the right direction and it is **not yet
correct**: three of the four survivors name strings the wire never emits.

| Advertised              | What a client actually receives                         | Source                                                                                                       |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `device.action_pending` | `event: device.action_pending` ✅                       | `sse-replay-hub.ts:195` encodes `event: ${frame.type}`; kind set at `defs/devices/[id]/actions/index.ts:401` |
| `maintenance.notice`    | `event: admin`, `data.type = "maintenance_notice"` ❌   | `defs/events/index.ts:127`, `:166`                                                                           |
| `maintenance.cleared`   | `event: admin`, `data.type = "maintenance_cleared"` ❌  | `defs/events/index.ts:130`, `:170`                                                                           |
| `session.changed`       | `event: session_changed` ❌                             | `watch-state-events.service.ts:35`                                                                           |
| _(not advertised)_      | `event: watch_state_set_changed` — a real, live emitter | `watch-state-events.service.ts:28`                                                                           |

So a third-party player that filters on the pruned list still gets exactly one working
subscription out of four, and misses a fifth kind that works and is not listed. The pruning
fixed "advertised with no emitter" and left "advertised under a name that never appears" —
which is indistinguishable from the original failure at the client.

**The invariant the list was missing: an advertised name is the literal SSE `event:` field,
verbatim.** Not a taxonomy label, not a tidied-up spelling. Every error in the table above is
a violation of that one rule.

### A second piece of ground truth

`user_notifications` is **provably empty on every install.** `insertNotification` has exactly
one caller (`notification-events.service.ts:184`), inside `publishUserEvent`, which has
exactly one caller — `defs/devices/[id]/actions/index.ts:399` and `:470` — and both pass
`persist: false`. Five public endpoints (`GET /api/v1/notifications`, `…/unread-count`,
`POST …/{id}/read`, `POST …/read-all`, `DELETE …/{id}`) serve a table nothing writes, and no
web surface reads it. (`NotificationBell.svelte` is the admin _attention_ system — unrelated.)

This is worth stating plainly because "the infrastructure exists" invites treating this as a
repair. The pipe exists; the inbox is an empty room with five doors. This is a greenfield
decision with the plumbing pre-laid.

## Two classes, not one list

The reason the advertised list keeps being wrong is that nobody can tell what a listed name
promises. `session_changed` and a new-episode notification are not the same kind of thing and
should never have shared a contract.

| Class            | Means                               | Durable                  | If the live frame is missed          |
| ---------------- | ----------------------------------- | ------------------------ | ------------------------------------ |
| **Notification** | An addressed message to a person.   | `user_notifications` row | Recoverable — poll the inbox         |
| **Signal**       | "Your view of X is stale, refetch." | never                    | Harmless — the next fetch is correct |

A notification is worth a badge, a row and a cross-pod guarantee. A signal is worth a refetch
and nothing else. Splitting them is the actual architectural decision in this document;
everything below follows from it.

## Taxonomy

### Notifications — three kinds

| Kind                  | Fires when                                                                  | Interest derived from                                                                        |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `library.new_episode` | An episode of a series the user watches or has watchlisted becomes playable | `user_watchlist` + `user_media_state`, minus `user_media_flags(flag_type='series_excluded')` |
| `request.available`   | Media the user requested becomes playable                                   | Jellyseerr request ownership                                                                 |
| `admin.broadcast`     | An administrator sends an announcement                                      | Explicit — the admin picks "all users" or names them (`admin_broadcasts.audience`)           |

The first two pass the bar on: user-initiated interest, server-side arrival, time-shifted,
and useless if you have to go looking. Both must survive a device switch, which is exactly
what a durable row is for.

`admin.broadcast` (added 2026-08-12, migration 16.209.0) passes on the same "time-shifted and
useless if you have to go looking" test but arrives at it from the opposite direction:
interest is not DERIVED at all, it is asserted by the sender. That is the one structural
difference and it is why the kind has an audience column rather than an interest query. It is
also the only kind that is **pinnable** — see below.

**It is not the `system.message` that was killed.** That entry rejected a durable twin of the
_existing perishable session toast_; this is a different feature with different requirements.
The next section spells the difference out, because "an admin sends a message" describes both
and conflating them would undo the reasoning in either direction.

#### Pinning, and the two invariants it introduces

An admin can pin a broadcast, which keeps it visible above the recipient's inbox until they
unpin it or an optional `pin_expires_at` passes. Pin state lives on the **parent**
`admin_broadcasts` row, not on each recipient's copy, so pin/unpin is one write rather than a
thousand-row UPDATE with a torn state while it runs.

Two consequences a client has to respect, both enforced server-side:

1. **A pinned row is excluded from `items` and returned in a separate `pinned` array.** The
   exclusion is an anti-join inside the list query, not a filter in the handler — filtering
   after the `LIMIT` would corrupt the keyset cursor, since `hasMore` comes from
   over-fetching by one and a page could come back short (or empty with `hasMore: true`).
   `pinned` accompanies the first page and any `?since=` delta, is unpaginated, and never
   overlaps `items`.
2. **A pinned row cannot be dismissed** — `DELETE /notifications/{id}` answers 409 while the
   pin holds. An operator pinned it so it would stay visible; a dismissal would undo that
   unilaterally. Marking it read is still allowed and is the intended action: it clears the
   badge while the announcement stays put.

Unpinning has **no wire event and needs none**. Pin state is only ever observed through a
fetch of the inbox, which evaluates the predicate live, so the next load or focus reconcile
is already correct — the same signal-class argument ("missing the live frame is harmless, the
next fetch is correct") that kept read-state reconciliation off the wire. A pin's lifetime is
measured in days; the staleness window is bounded by when a user could notice.

**`request.status_changed` is deliberately renamed to `request.available`.** Only the terminal
edge earns a durable row. `downloading` → `importing` → `synching` is what the existing
client-side poll is already good at, and emitting on every transition turns one user action
into six inbox rows. The name matters: `status_changed` invites exactly that.

### Signals — four kinds, all already working

`device.action_pending`, `session_changed`, `watch_state_set_changed`, `admin`. All exist,
all emit, none persist, none should. (2026-10-16: `device.action_pending` and the
`/devices/{id}/actions` queue were replaced by device remote control — `device.command`,
`device.command_cancelled`, `device.command_status`, `device.state`; see
`docs/superpowers/specs/2026-10-16-device-remote-control-design.md` in the private repo
root. `device.command*` frames for one device carry `targetDeviceSessionId`: the hub
delivers them only to that device's stream and never replays them.) They get advertised under their wire names and nothing
else changes about them.

#### `admin` got a published frame contract (2026-09-12)

The kind is untouched; what changed is that its payloads are now written down. The tvOS/iOS
team could not build against it: `responses.200` on `GET /api/v1/events` is `type: string`
(an SSE body cannot be typed structurally), so no `event:` name, no discriminator and no
field set existed anywhere a client could read. Four component schemas now carry them —
`SseConnectedFrame`, `SseAdminMessageFrame`, `SseMaintenanceNoticeFrame`,
`SseMaintenanceClearedFrame`, registered manually in `scripts/openapi/sse-frames.ts` because
no operation can reference them. `Events` moved `beta` → `stable` on the back of that:
evolution is additive only (new `event:` names, new optional fields — hence `looseObject`,
so `additionalProperties: false` cannot turn "ignore what you don't know" into a rejected
frame).

Three findings from freezing it, each of which changed code:

1. **A session-targeted toast never reached the per-user stream at all.** `BroadcastTarget`
   carried a field named `username` and the one producer passed `session.user_id` — a UUID —
   into it, compared against the SSE connection's handle. The equality never held, so only
   the web player's own session-scoped channel ever delivered one, which is exactly what the
   native clients reported. The field is now `userId` and the comparison is UUID-to-UUID.
   `shouldDeliverAdminMessageToUsername` had green unit coverage throughout, because it
   tested the comparison against its own fixture rather than against the producer — the seam
   test in `defs/admin/sessions/admin-session-commands.test.ts` is the one that catches it.
2. **The stream is per-USER and cannot narrow to one client.** Two Apple TVs on one account
   share every frame, so a targeted `admin_message` now carries `playSessionId` / `deviceId`
   and the CLIENT filters (absent = broadcast). The alternative — routing device-targeted
   messages through the `devices/{id}/actions` queue as a third action type — was rejected:
   that queue needs a `deviceSessionId` claim, so it cannot reach a PAT or web session, and
   shipping both paths for one feature is worse than shipping the weaker one.
3. **"A persistent banner with a live countdown" is state, not an event.** A client that
   launches or foregrounds after the broadcast can never learn about it from a frame it did
   not receive, and for a mobile client that is the normal case. `GET /api/v1/server/notice`
   is the read path; the SSE snapshot after `connected` stays as the push. Both read the same
   Valkey key, and the HTTP read is authoritative if they ever appear to disagree. It is
   kept separate from `GET /api/v1/server`: notices are moment-state and use `no-store`.

`admin_message` also gained an inlet-side condition: the admin UI only offers "Send message"
for a session whose client ANNOUNCED it can draw one (`play_sessions.client_features`,
migration 16.247.0 — see `src/lib/shared/client-features.ts`). A feature list rather than a
version check, because tvOS, iOS and web version independently and the toast is expected to
ship before the banner. The maintenance button is deliberately NOT gated the same way: a
broadcast has no single target session, and a client that ignores the frame is the correct
failure mode, so the operator gets a reach count instead of a disabled button.

### Killed

`social.comment`, `social.reaction`, `social.invite`, `system.message`.

**Corrected 2026-08-11. The original justification here was "the first three describe
features that do not exist. There are no comments, no reactions." That was wrong about the
first two**, and the correction matters because the false version is easy to disprove and
would take the (correct) conclusion down with it.

**Comments and reactions ship.** Twelve endpoints, generated by `makeCommentsDef` /
`makeReactionsDef` in `defs/interactions/handlers.ts` and mounted on three target types:

| Target     | Endpoints                                             |
| ---------- | ----------------------------------------------------- |
| `media`    | `media/[id]/comments`, `media/[id]/reactions`         |
| `playlist` | `playlists/[id]/comments`, `playlists/[id]/reactions` |
| `person`   | `people/[id]/comments`, `people/[id]/reactions`       |

They are backed by the polymorphic `interactions` and `interaction_reactions` tables and
carry their own authz, cursor and OpenAPI-contract tests. They are real.

**Usage is the gate for adding notification kinds.** An install can have active playback
while its `interactions` and `interaction_reactions` tables remain empty. Implemented
endpoints alone do not establish demand for comment notifications.

So the kill stands pending **usage evidence**. A notification kind is a promise to a client
and a durable row per event; neither
earns its place for a feature nobody has invoked once. The reviving evidence is therefore
not "someone builds comments" (they are built) but **someone uses them** — a non-trivial
`interactions` count on a real install. Until then a `social.comment` emitter would fire for
nobody.

**`social.invite` is the one that really does describe a missing feature**, and more
completely than this document previously implied. Under the household-audience model there
are no audience invitations by design; separately, the only per-user invitation mechanism
that exists anywhere in the codebase is `playlist_members`, and Watch Together — the
feature most people assume
has invitations — has none at all, only a join code (`social-sharing.md`, "What deliberately
does not change"). `social.invite` revives with Circles, at step 1 of that rollout
(`social-sharing.md`, Appendix), and not before.

One thing to keep in view if it is ever revived: both current notification kinds are
time-shifted, and the class contract says a missed frame is _"recoverable — poll the
inbox"_. A party or circle invitation is **perishable** — an inbox badge forty minutes later
is worse than nothing. It is the first kind that would genuinely need the push path to be
real, not the inbox. That is an argument about which delivery surface it needs, not a reason
to skip the durable row, but it should be settled before the descriptor is added rather than
after.

**`system.message` — the kill stands, and `admin.broadcast` is not a reversal of it.**
Updated 2026-08-12, because the original wording ("a second, durable path for the same thing
is duplication") is easy to misread as "an administrator may never send a durable message",
which is not what was decided and not what the reasoning supports.

What was rejected was a **durable twin of the existing perishable toast**. That toast is
already served: `adminEvents` fans `admin_message_broadcast` cross-pod via Valkey pub/sub,
filtered per-username at `defs/events/index.ts:140`, and it works. Persisting _that_ would be
duplication, and worse — its content is written for the moment ("the stream is restarting in
five minutes") and is actively misleading an hour later.

`admin.broadcast` is a different message with a different lifetime, and every property
follows from the one difference — it addresses **people**, where the toast addresses **live
playback sessions**:

|                               | `admin` (signal)                          | `admin.broadcast` (notification)            |
| ----------------------------- | ----------------------------------------- | ------------------------------------------- |
| Addresses                     | Active play sessions                      | Users                                       |
| Reaches a user who is offline | No, and that is correct                   | Yes, and that is the point                  |
| Lifetime                      | 60s staleness window, then gone           | Durable row, no TTL                         |
| Missed frame                  | Harmless — the message has expired anyway | Recoverable from the inbox                  |
| Content                       | Perishable and operational                | An announcement that stays true for a while |
| Pinnable                      | No                                        | Yes                                         |
| Surface                       | `/admin/users/sessions` → "Send message"  | `/admin/notifications`                      |

They stay **separate features on separate pages**, sharing only the word "broadcast". Merging
them would either give the operational toast a durable row nobody wants, or give the
announcement a 60-second life that defeats it. The `admin` signal kind is untouched by the
2026-08-12 change.

**`PERSIST_KINDS` should be trimmed to the notification kinds.** It stays a separate list
from the advertised one — they answer different questions and re-merging them is how this
started — but it once named six kinds for a set that should hold three, and that is a live
hazard rather than a record of intent: a stray `publishUserEvent({kind: 'social.comment'})`
would silently write inbox rows for a feature that does not exist. Keep the concept separate,
trim the contents.

The same separation applies to **`PUSH_KINDS`**, which is derived from the notification class
and must stay that way. A broadcast's per-send "also send a push" checkbox is a
**per-invocation** `skipPush` argument to `publishUserEvent`, not a taxonomy edit: "is this
KIND the sort of thing that pushes" and "did the admin tick the box on this particular send"
are different questions, and folding the second into the first would make one send's
preference look like a permanent statement about the kind.

## Emitters and hook points

Both notification kinds hang off **one** hook: `registerPipelineEventHandler('media.becamePlayable', …)`.
New service `user-notifier.service.ts`, registered beside `MediaAddedNotifier` in the
orchestrator (precedent: `media-added-notifier.service.ts:149` for the registration,
`tasks/orchestrator.ts:502` for the wiring).

On `media.becamePlayable`:

1. **Gate on `isInitializingWindow(sql)` first.** Copied from `media-added-notifier.service.ts:74`.
   Without it, a fresh install fires one notification per item of the initial import to every
   user. This is the single highest-consequence line in the whole design and it is already
   solved one file over.
2. **New episode.** Resolve the item; if it is an episode, walk to the series — note
   `episode.parent_id` is the **season**, not the series. Find the users to tell with the rule
   of the "New episodes available" banner (`new-release-rule.ts`, fed series → users by
   `getSeriesFollowers`), not a reimplementation of it: followers (2+ viewing moments, the
   per-series episode-notification switch, or watchlisted and started) for whom the episode is
   a new release (aired in the last 30 days, after their last watch or beyond the newest
   episode they watched, not part of a bulk back-catalogue arrival). `series_excluded` removes
   all but explicit followers. Until 2026-10-20 this was the two-tier ACTIVE/HISTORICAL rule,
   which told an active viewer about every episode that became playable, including the old
   seasons of a fulfilled request. Then apply the per-user library and age gate — a
   notification must never reveal an item the user cannot see. Emit `persist: true`.
3. **Request available.** Ask Jellyseerr who requested this item (`getRequests`,
   `jellyseerr.ts:394`), map Jellyseerr user → Lumastra user by username, apply the same access
   gate, emit `persist: true`. Skip entirely when `jellyseerrClient.isConfigured()` is false —
   that is the capability's `available: false` case, below.

**Coalescing is required, not optional.** A season drop is one notification, not ten. One row
per `(user, kind, series, season)` per day, enforced by a unique partial index rather than by
handler logic. Recorded here so it is designed in rather than discovered on the first Friday
a full season lands.

## Subscription model

**Derive subscriptions from interest the user already expressed. No follow concept, and — the
stronger claim — no new interest table.**

The prior holds up under pressure, and the reason is more specific than "it's simpler":

The only real advantage of an explicit follow is that the user knows why they were notified.
Derived interest can surprise. But the derivation that would surprise them **already exists,
is already tuned for exactly that, and is already user-visible**: the banner's follow rule
(`new-release-rule.ts`) is a follow model with an implicit join, and `series_excluded` is its explicit
unfollow, already surfaced in the new-episode banner. Adding a follow concept would create a
_second_ answer to "is this user watching this series", which must then be reconciled with the
banner's answer forever, and which will disagree.

So the rule is: **if a surface already decides whether a user cares about a series, the
notifier calls that code.** Never a parallel copy.

One distinction the prior flattens and which the emitter must not: **watchlist is interest in
an item; watch state is interest in a series.** Different joins, different mute semantics — a
watchlist entry is removed, a series is excluded. Both feed `library.new_episode`; neither
substitutes for the other.

**Per-kind notification preferences are a non-goal at three kinds.** `series_excluded` already
mutes the noisy one, and a notification about media you personally requested is not spam by
construction.

The third kind arrived (`admin.broadcast`, 2026-08-12) and did NOT trigger the revisit this
paragraph originally promised, which is worth recording rather than quietly dropping. A
per-user mute for an operator announcement is a contradiction — the sender is the person who
runs the server, and an announcement a recipient can opt out of is not one. The per-send
`pushEnabled` toggle is the control that actually matters here, and it belongs to the
**sender**: an admin decides whether a given announcement is worth a lock-screen
interruption, rather than every user deciding once for all of them. Revisit if a fourth kind
appears that is both derived-interest and genuinely optional.

## Cross-pod live delivery: yes

Reversing the "known follow-up" framing. This should be built, and early.

**It is not infrastructure work.** `subscribeToChannel` (`cache/valkey.ts:1416`) and
`publishMessage` (`:1393`) already exist, and `play-session-events.service.ts` already runs
three channels on this exact pattern for kills, supersedes and maintenance. The change is one
channel and a subscriber callback.

**The degradation argument does not transfer from `device.action_pending`.** That kind is
explicitly a low-latency hint whose durable queue at `/devices/{id}/actions` is the truth, so a
missed frame costs a poll interval. Both new notification kinds are emitted from the
**pipeline-event dispatcher, which runs in the task orchestrator — the worker pod** — while
every SSE consumer is on a web pod. `broadcast()` there does not "sometimes miss": it reaches
zero consumers, always. That is not degradation, it is the feature not working.

**Valkey replay does not cover this.** `readReplaySince` runs once inside `streamResponse`'s
`start()` (`sse-replay-hub.ts:150`, called at `:254`); after that the consumer receives only
local `broadcast()` frames. There is no pub/sub subscribe and no list polling. A cross-pod
frame therefore arrives on the _next reconnect_ and not before. Two further limits worth
recording, because they bound how much anyone should ever trust replay:

- The replay LIST is **shared across all users** with `replayMax: 500`. One busy user's frames
  evict another's.
- `replayTtlSec: 3600` is refreshed per push, so an hour of instance-wide quiet drops the list
  entirely, frames included.

Replay is a reconnect-smoothing buffer, not a delivery guarantee. **Anything that matters is a
Postgres row**; the SSE path is the low-latency half and nothing more. That is why both new
kinds are `persist: true` and why cross-pod is worth building anyway — the row makes it
correct, the fan-out makes it feel live.

**The one trap when implementing:** the pub/sub subscriber callback runs on the publishing pod
too. Follow the pattern `play-session-events.service.ts:334` documents — move the
`userEventsHub.broadcast()` call _into_ the subscriber and out of `publishUserEvent`, with a
local-delivery fallback when Valkey is unavailable. Tagging frames with an origin-pod id to
dedupe is the worse option; the established pattern removes the duplicate-delivery class
entirely.

### What deliberately stays pod-local

**`watchStateEvents` is not fixed as a matched pair.** It is a signal, emitted from both web
(playback lifecycle) and worker (sync), and a missed refetch hint is genuinely benign — the
next navigation fetches correct data. Routing it cross-pod adds a channel and a failure mode
to make a cache-invalidation hint marginally faster.

This is exactly what the two-class split buys: cross-pod is a guarantee the notification class
needs and the signal class does not. Recorded so it reads as a decision rather than an
inconsistency someone should quietly close.

## Client contract

Yes — capabilities must distinguish "this server understands the kind" from "this kind can
actually arrive here". Replace the flat `event_types: string[]`:

```jsonc
"events": {
  "url": "/api/v1/events",
  "reconnect_max_ms": 30000,
  "kinds": [
    { "name": "library.new_episode",     "class": "notification", "durable": true,  "available": true },
    { "name": "request.available",       "class": "notification", "durable": true,  "available": false,
      "unavailable_reason": "requests_not_configured" },
    { "name": "device.command",          "class": "signal", "durable": false, "available": true },
    { "name": "device.command_cancelled","class": "signal", "durable": false, "available": true },
    { "name": "device.command_status",   "class": "signal", "durable": false, "available": true },
    { "name": "device.state",            "class": "signal", "durable": false, "available": true },
    { "name": "session_changed",         "class": "signal", "durable": false, "available": true },
    { "name": "watch_state_set_changed", "class": "signal", "durable": false, "available": true },
    { "name": "admin",                   "class": "signal", "durable": false, "available": true }
  ]
}
```

- **`name` is the literal SSE `event:` field.** The invariant that would have caught three of
  the four current entries.
- **`available` is per-install and config-derived.** `request.available` is false when
  `jellyseerrClient.isConfigured()` is false. This is the answer to "understands vs can
  arrive", and it is the right place for it: it converts "a quiet server" from an
  indistinguishable state into a checkable one.
- **`durable`** tells a client whether missing a live frame is recoverable. `true` → also poll
  `GET /api/v1/notifications`. `false` → live or never.
- **Keep `event_types: string[]` for one release** as the deprecated flat projection
  (`kinds.filter(k => k.available).map(k => k.name)`). It is a shipped public surface.

### One handler, two mounts, two auth models

Found while building the web client, and load-bearing enough that it belongs in the contract
rather than in a commit message.

`defs/events/index.ts` is mounted twice: `/api/v1/events` (Bearer) and `/api/events/user`
(cookie / forward auth). **A browser cannot use the advertised URL.** `EventSource` has no API
for setting an `Authorization` header, and the reverse proxy does not inject forward-auth headers on
`/api/v1`. So the web client connects to the internal mount and third-party players connect to
the advertised one — same handler, same six wire names, different front door. The existing
`watchStateSSE` and `runSSEBus` clients already solve it this way; this is not a new split, it is
an existing one that the capability surface had never had to name.

What `capabilities.events.url` advertises is therefore **the third-party URL, and only that**.
That is correct — a capability document is read by Bearer clients — but it means the field is not
"where the event stream is", it is "where _you_, a token-bearing client, reach it". Do not
"fix" the web client to use the advertised URL; it will 401.

### The guard, because a comment is not a mechanism

The list drifted because nothing connected it to reality — the current warning against
re-merging the lists is an honour system, and honour systems are what produced eleven
advertised kinds with four emitters. Two cheap mechanisms:

1. Emitters take their kind from a shared const, so each wire string exists exactly once.
2. A unit test asserting every `kinds[].name` appears as a literal in an emitter — the inverse
   of the current comment.

**That test must have no skip list.** A checker with a growing skip bucket is a silent failure,
and this is precisely the surface where one would hide.

## The request popup moves into the inbox — partially

**Yes for `available`, no for everything before it.**

The popup does two jobs. During `downloading` / `importing` it is a live progress bar: that is
a signal, the client-side poll is the right mechanism, and putting it in a durable inbox writes
a row per polled transition. At `available` it is "your thing is ready" — a notification by
every definition here, and precisely the state that dies when the user switches devices.

So: leave the poll-driven popup unchanged for in-progress states; add the `request.available`
durable row; let an unread row hydrate the widget on any device, and let dismissing it mark the
row read.

> **Correction (2026-08-25).** The hydration clause did not survive contact. See the dated
> correction under "The popup is not deleted" below: the durable row and the emitter are
> right and stay, but the popup no longer renders that row — the terminal card is
> per-device and poll-owned, and one dismiss path serves every card.

**The real work in this item is not the emitter — it is that there are two dismissal systems.**
Popup dismissals live in `user_media_flags(flag_type='request_dismissed')`, keyed by an
external-ID string built in `notification-persistence.service.ts`. The inbox row is keyed by row
id. Running both independently produces "dismissed on my phone, still showing on the TV", which
is the exact bug this change exists to fix.

> **Correction (2026-08-04, found during implementation).** An earlier version of this section
> said `read_at` becomes the truth and "the flag path retires". **That was wrong — do not do
> it.** `request_dismissed` has a second consumer this document missed:
> `defs/for-you/fulfilled-requests.ts` uses `getActiveFlagTargets(flagType:'request_dismissed')`
> as the anti-join for the For-You "fulfilled requests" section, and `defs/for-you/dismiss.ts`
> writes it. Retiring the flag would silently empty-out or un-dismiss that surface with no test
> failure.
>
> The goal is **consistency, not retirement**: dismissing a fulfilled request in any surface —
> popup, inbox drawer, or the For-You section — dismisses it in all three, via one shared
> sync helper rather than scattered writes. The two key shapes differ (an external-ID string
> that deliberately excludes UUIDs, versus the inbox row's `mediaId` UUID), so the mapping
> between them is the actual hazard and must be written down, not inferred.
>
> The general lesson is worth more than the specific fix: **before retiring a flag, grep for
> every reader.** A flag store shared across surfaces has no type-level owner, so "this is the
> popup's dismissal state" was an assumption, not a fact.

### The key mapping, written down

`request_dismissed` is written in **two incompatible key shapes**, and each reader understands
only its own:

| Shape      | `target_id`                      | `target_type`          | Written by                                     | Read by                                                    |
| ---------- | -------------------------------- | ---------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| **K-EXT**  | `tmdb:550:movie`, `tmdb:1399:tv` | `'request'`            | `request-status/dismissals.ts#upsertDismissal` | `getDismissalsForUser()` → the popup's `dismissedMap`      |
| **K-UUID** | `media_items.id` (bare UUID)     | `'movie'` / `'series'` | `defs/for-you/dismiss.ts`                      | `fulfilled-requests.ts`'s anti-join (matches internal ids) |

The durable inbox row is keyed by neither: `user_notifications.id`, with the media identity in
`payload.mediaId` — a **UUID**.

K-EXT is `buildExternalIdKey(externalIds, mediaType, { includeUuids: false })` — the provider
priority chain with UUIDs deliberately excluded, because the popup rebuilds its ids from
Jellyseerr's TMDB-only payload. Its media-type token is the **storage** spelling `'tv'`, never
the public `'series'`; stored rows depend on that.

**No single key is legible to all three readers, so a dismissal is canonicalized to the pair
`{uuid, extKey}` and BOTH flag rows are written.** Picking one shape would break the other
reader — the same failure as retiring the flag, one level down.

`src/lib/server/services/request-dismissal-sync.service.ts` is the one place that does this.
Every dismiss path calls it (`POST /notifications/{id}/read`, `DELETE /notifications/{id}`,
`POST /notifications/read-all`, `POST /for-you/dismiss`, `upsertDismissal`), and the two
un-dismiss paths call its inverse so a re-request cannot leave a mirror flag behind. It is
fired without awaiting: a reconcile failure must never fail the user's dismiss.

What cannot round-trip, stated rather than silently no-op'd:

- **Media not in the local catalog** (a Jellyseerr request with no `media_items` row) → no
  UUID; K-EXT only, and no inbox row can be located (`unmapped: 'no-uuid'`). Benign — the
  For-You rail already skips unmatched rows and no inbox row exists for it.
- **A local-only item with no provider id** → K-EXT is underivable, so the popup's
  `dismissedMap` cannot see this dismissal (`unmapped: 'no-external-id'`). The inbox row and
  the For-You rail are still reconciled.

## Delivery surfaces

"The notification is a popup" conflates two problems. **Shape** — ephemeral, per-device,
client state — is what the durable row fixes. **Reach** — where a notification can find a user
who is not currently looking at the popup — is a separate question, and the row is what makes
it answerable: once a notification is a row, every surface is a reader of one table and each
can be added or skipped independently.

Ranked. The ordering is deliberate: the cheapest items are also the most valuable, which is
the usual shape of this question and the reason push tends to get built first anyway.

### Build — the in-app inbox (bell + drawer)

This is the real gap, and it outranks every outbound channel. A popup can only tell you
something while you are looking at it; a badge tells you when you **come back**, which is how a
media server is actually used — you open it when you want to watch something.

It is also the cheapest item here: **all five read endpoints already ship and nothing reads
them.** `GET /api/v1/notifications`, `…/unread-count`, `POST …/{id}/read`, `…/read-all`,
`DELETE …/{id}`. This is pure client work against a shipped API, with an interaction precedent
already in the codebase — `NotificationBell.svelte` / `NotificationDrawer.svelte` in
admin/attention, a different data source but a proven shape.

This resolves the second open decision below in the affirmative.

### Build — OS notifications from the service worker, while a tab is open

The **Notifications** API, not the Push API. `registration.showNotification()` driven by the
SSE frame the client is already receiving. No VAPID, no subscription table, no server-side
delivery path, no new failure mode — one permission prompt and a `notificationclick` handler.

`static/sw.js` is already registered with install / activate / fetch / message handlers and has
no notification handling yet; `src/routes/manifest.json/+server.ts` is a real installable
manifest. So the prerequisite is done.

It cannot reach a closed browser. It does cover "Lumastra is open in a background tab and my
download finished", which is a large share of the real cases, at close to zero cost.

### Build, admin-gated off by default — one per-user webhook URL

ntfy / Gotify / Discord / Home Assistant shaped. Self-hosters already run one of these, and
pointing Lumastra at what they have beats asking them to adopt another push system.

The machinery exists: `WebhookOutbox` has exponential backoff, HMAC signing, a DLQ and an admin
outbox view. A user-scoped hook is a `user_id` column and a filter, not a subsystem —
`webhook.queries.ts` has no `user_id` today because every hook is operator-configured.

**The cost that must not be hand-waved: a user-supplied URL is an SSRF surface that an
operator-configured hook is not.** Operator hooks are trusted by definition; a user pasting a
URL is not. This needs egress restrictions — link-local, cloud metadata endpoints, private
ranges — and it is why the feature ships off by default rather than on.

#### Two corrections, from building it (migration 16.192.0)

**The egress guard already existed.** `assertPublicHttpUrl` + `safeFetch` (`tasks/url-safety.ts`)
cover every range named above plus CGNAT, benchmarking, TEST-NET, multicast, `.local`, embedded
userinfo and non-http schemes, with DNS resolution and per-hop connection pinning against
rebinding — and `WebhookOutbox` already applied them to every delivery. The work was not writing
a guard, it was making the per-user path go through the SAME one, and adding it at SAVE time so a
rejected URL is a 422 in front of the user rather than a dead outbox row on an admin screen they
cannot open. A second implementation would have been the actual mistake. The default stays OFF
regardless: "this server will make outbound requests to addresses its users choose" is an
operator decision, not a guard-quality question.

**"A `user_id` column and a filter" was the wrong half of the right instinct.** It is not a
subsystem — that part holds, and delivery rides `WebhookOutbox` unchanged. But a nullable
`user_id` on `task_webhook_hooks` makes ownership a value rather than a type, and three existing
readers (`listWebhookHooks` → the admin list, `loadHooks` → operator fan-out,
`listActiveMediaAddedHooks`) would each have needed a predicate they were written without, with a
silent failure on each. It also means eight permanently-NULL filter columns and the opposite GDPR
strategy in one table (`created_by` is an actor username and is tombstoned; a user hook IS the
subject's data and must be deleted). So: a separate `user_notification_webhooks` table, and one
nullable `task_webhook_outbox.user_hook_id` with a `num_nonnulls(hook_id, user_hook_id) = 1`
CHECK — strictly stronger than the `hook_id NOT NULL` it replaces — so the two ownership models
share a delivery worker without ever sharing a row.

**Fire point:** inside `publishUserEvent`, on `inserted` only. The durable INSERT is the arbiter
of live delivery, so a coalesced duplicate already produces no toast; sitting behind that same
return is what makes it produce no push either. A persist _failure_ (DB down) deliberately does
NOT enqueue, unlike the live frame — an unarbitrated event would be enqueued once per parallel
outbox shard, and an outbox row is durable and retried for 24 hours where a duplicate toast is
not.

**Payload shape, honestly:** `WebhookOutbox` reads `payload.type` / `payload.id` for its
`X-Lumastra-*` headers, so the body IS a CloudEvent envelope — the only way out would be the
parallel delivery path this feature must not build. `title`, `message`, `content` and `click` are
mirrored as top-level extension attributes, which makes Gotify and Discord render correctly and
lets Apprise / n8n / Home Assistant template. **ntfy does not work pointed at directly**: its JSON
publishing mode wants the topic in the body, and posting a JSON body to `https://ntfy.sh/<topic>`
renders the whole blob as the message text. Users are told to put a relay in front rather than
told it is fine.

> **Correction (2026-08-04, found during implementation): this cost is already paid.**
> `assertPublicHttpUrl` / `UrlSafetyError` in `src/lib/server/utils/ssrf-guard.ts` already
> exists and is already wired into `WebhookOutbox` delivery (`webhook-outbox.ts` ~:465),
> together with a redirect policy — because operator hook rows could predate the guard. A
> per-user hook inherits it by riding the same outbox. The remaining work is to run the _save_
> path through the same guard too, so a user gets an immediate error rather than a silent DLQ
> entry later. Writing a second guard would be the mistake. The feature still ships off by
> default, but on operator-consent grounds rather than unmitigated-SSRF grounds.

### Defer — Web Push

**Revising the earlier non-goal, which was overstated.** A service worker and an installable
manifest already exist, so the hardest structural prerequisite is done. That is a genuine
weakening of the original "out of scope".

It is still a defer:

- **iOS requires the PWA be installed to the home screen** for Web Push. Lumastra's iOS story is
  a native/TV client, so the platform where a push would matter most is the one where it works
  least.
- VAPID key generation and storage, a subscription table, and silent subscription expiry that
  needs constant pruning. A second delivery path with its own retry semantics.
- **The content does not earn an interruption.** "New episode of a show you watch" and "your
  request finished" are pull-worthy, not push-worthy. Notifications that interrupt a phone for a
  TV episode train people to ignore the app.

**What would revive it:** someone asks for it _and_ the per-user webhook path proved
insufficient for them. Not before both.

### Reject — email

No SMTP exists anywhere in the codebase, and the missing piece is not the plumbing. Email means
deliverability (SPF/DKIM, or notifications land in spam), bounce handling, an unsubscribe story,
and templates in both UI locales — for two low-urgency kinds. A self-hoster who wants email
already routes ntfy or Apprise to it.

Note the asymmetry, because it decides how each gets revisited: **push is deferred on value,
email is rejected on cost.**

### Native client push (APNs) — SHIPPED, relay-based

This was recorded as out of scope on the grounds that "a self-hosted server cannot send
APNs without either the operator's own certificates or Lumastra operating a push relay.
That is an open-core product decision, not an architecture one." The decision was
subsequently made: **Lumastra operates a relay.**

Push now rides the same `'inserted'` gate as the per-user webhook — see
`services/push/user-push-notifier.service.ts` — and delivers through
`tasks/push-outbox.ts` on a deliberately short (~21 minute) ladder. Notification text is
rendered on this server with an explicit Paraglide locale; the relay receives a generic
banner plus device tokens and never sees a media title.

Note that the "Defer — Web Push" section below is unaffected — its reasoning stands.

### The popup is not deleted

Worth stating so it does not get "cleaned up" once the inbox lands. Its live-progress role
during `downloading` / `importing` is correct and the inbox is the wrong home for it. The change
is narrow: the popup keeps the in-progress states, the inbox owns the terminal one, and the
popup's _available_ card becomes a rendering of the inbox row rather than its own state.
Otherwise two surfaces show one event with two dismiss semantics — the same
`request_dismissed` / `read_at` split named above.

> **Correction (2026-08-25, after living with it).** The last sentence of that paragraph is
> retired. **The terminal `available` card stays popup-owned and per-device**; it is NOT a
> rendering of the inbox row. `hydrateFromInbox()`, the `inboxId` field, and the
> mark-the-row-read dismiss path are deleted.
>
> The premise was that without client-side hydration the two surfaces would drift into "two
> dismiss semantics". They do not, because the reconcile below already runs in **both**
> directions and neither direction involves the client:
>
> - popup dismiss → `upsertDismissal` → `scheduleRequestDismissalSync` →
>   `markRequestAvailableReadByMediaId` retires the row.
> - row read / deleted / read-all → `scheduleDismissalSyncForInboxRow` (wired in all three
>   `defs/notifications` routes) → **both** `request_dismissed` flag shapes → the popup's
>   `syncFromServer()` eviction filter drops the card on the next focus.
>
> So hydration was a second, redundant reconciliation channel. Its cost was not redundancy
> but IDENTITY BRIDGING: it had to match a composite-key card (`tmdb:550:movie`) against a
> UUID-only inbox payload, across two media-type vocabularies. That is precisely where the
> `tv`-vs-`series` dismissal-key bug lived (fixed in `8d7057c64`; a series dismissal was
> written as `tmdb:95350:tv` and read back as `tmdb:95350:series`, so no series card could
> ever be dismissed). Deleting the bridge deletes the bug class.
>
> **Two things were weighed and rejected.** Removing the terminal card from the popup as well
> (leaving the drawer to own "ready") would have re-introduced a flicker of the same family:
> a still-airing series never leaves Jellyseerr's pending list, so `syncFromServer()` re-adds
> it as `pending` on every focus and the poll then removes it again — a ghost card blinking
> for up to the 14-day sync `maxAge`. Suppressing that needs a NEW persisted tombstone, i.e.
> deleting reconciliation code and immediately writing different reconciliation code. And it
> is a UX downgrade: the drawer row's `link` renders as `/?modal=<uuid>` (`hrefFromLink`),
> so playback from the drawer is bell → row → modal → Watch, against the popup's one-click
> `Watch now` → `/watch/{key}`.
>
> **What is genuinely given up:** a device that never tracked the download no longer grows a
> terminal card on its own for an already-available movie. That is the drawer's job and
> push's — durable surfaces, which is the point of them. The "key mapping, written down"
> section above remains fully in force.

## Where to start

Ordered by dependency, not by size.

1. **Fix the advertised names to match the wire, add the `kinds` shape, add the no-skip-list
   guard.** No new emitters. Independently correct, cheap, and a prerequisite for any client
   trusting the surface.
2. **Cross-pod fan-out for `publishUserEvent`** — reuse `subscribeToChannel`, move `broadcast()`
   into the subscriber. Without it, step 3 delivers nothing live.
3. **`user-notifier.service.ts` with `library.new_episode` only.** One kind, one emitter,
   reusing `new-episodes.service.ts`'s interest rule and `isInitializingWindow()`. Proves the
   whole path end to end: worker → Valkey → web pod → SSE → inbox row → API.
4. **`request.available` + popup reconciliation**, including retiring the `request_dismissed`
   flag path. Last because it has the messiest state merge, not because it matters least.
   (Both halves of this item were later corrected: the flag path was NOT retired — see the
   2026-08-04 correction under "The request popup moves into the inbox" — and the popup
   reconciliation was subsequently deleted outright, see the 2026-08-25 correction under
   "The popup is not deleted". The messy state merge was the warning sign, read as a cost
   rather than as a signal that the merge should not exist.)

## Non-goals

- A follower graph, a follow concept, or any new table expressing "user cares about X".
- Per-kind notification preferences, while there are three kinds. (`admin.broadcast` would be
  the awkward one anyway: an announcement a user can mute is not an announcement.)
- Email. Web Push is deferred rather than a non-goal — see Delivery
  Surfaces for the trigger. A per-user outbound webhook is in scope but gated off by default.
- Confusing any of the above with operator webhooks. `media-added-notifier.service.ts` fanning
  `org.lumastra.media.item.added` is an outbound integration surface aimed at the operator, a
  different concern, and it stays separate — even though a per-user hook would ride the same
  `WebhookOutbox`.
- Digesting or batching beyond the per-season coalesce.
- Notifications for social kinds whose features do not exist. `social.invite` returns with
  Circles or not at all.
- `request.status_changed` on intermediate states.
- A generic subscription registry, or one polymorphic event bus for pipeline events, user
  events and webhooks.
- Cross-pod delivery for the signal class.
- Merging `PERSIST_KINDS` and the advertised list. They answer different questions. Same for
  `PUSH_KINDS` and a per-send push toggle — that is a `skipPush` argument, not a kind.
- Editing a notification's text after it is sent, for any kind including `admin.broadcast`.
  The row has already been copied into every recipient's inbox and mirrored into however many
  push banners; an edit would leave those disagreeing forever. Retraction is deletion of the
  parent broadcast, which cascades to every copy.
- A link or URL target on `admin.broadcast`. Widening `NotificationLink.target` to something
  an admin can point anywhere is an open redirect that every already-shipped client would
  follow. An announcement renders as readable-but-not-tappable instead.
- A wire event for pin/unpin. It is observed through the inbox fetch, which evaluates the pin
  live; a seventh advertised kind is a permanent public-contract widening for a change
  measured in days.
- Merging the perishable `admin` session toast with `admin.broadcast`. See Killed above.
- Re-adding a kind to the advertised list to satisfy a client. An emitter earns the entry; the
  entry never earns the emitter. That inversion is what created this.

## Open decisions

- ~~Whether `library.new_episode` should fire for a watchlisted _series_ the user has never
  played.~~ **Decided 2026-10-20: no.** The notification follows the banner's rule, where the
  watchlist counts once the user has started the series.
- ~~Whether the web app should grow an inbox surface at all.~~ **Decided: yes** — see Delivery
  Surfaces. It is the cheapest item on that list and the only one that gives the durable row a
  reader on the web client.
- Whether the per-user webhook is per-kind filterable or all-or-nothing. All-or-nothing at two
  kinds; the question returns with a third, alongside per-kind preferences generally.
