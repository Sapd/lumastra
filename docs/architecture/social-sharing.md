# Social Sharing Architecture

This document has two parts. The first describes what we are actually building: a single
implicit **household audience** that makes the existing sharing features usable without
four steps of operator setup. The second is a deferred design for user-managed **Circles**,
kept as a design of record for the day an install genuinely needs more than one audience.

The split is deliberate. The circle design is sound, but at the installation sizes this
project targets its steady state is one circle containing everyone — an invitation,
acceptance, ownership and picker system built to express a constant. The expensive part of
that design (a single visibility predicate every social surface funnels through) is already
built and shipped, so deferring the rest costs almost nothing and can be revisited without
touching any consuming surface.

## Goals

- Let a household see each other's activity without the operator configuring groups.
- Keep privacy sharing separate from administrative authorization.
- Preserve global, per-dimension and per-item opt-outs as the real privacy controls.
- Keep one place where "may the viewer see this?" is decided.
- Stay correct at ~1000 users even though the UX is tuned for ~100.

## Installation Sizes

Every decision below is calibrated against these bands. They are not hypothetical
segments; they are what self-hosted installs of this project actually look like.

| Users      | Reality                                 | What the design does                                                 |
| ---------- | --------------------------------------- | -------------------------------------------------------------------- |
| **1–4**    | One household. Everyone shares already. | Household audience, on by default. The user never learns a new word. |
| **5–20**   | Family plus a few friends.              | Same. A second audience is conceivable but rare.                     |
| **21–50**  | Extended friends or a small community.  | Same, with the operator free to turn the household audience off.     |
| **50–100** | Small community server.                 | "Everyone" stops being an obvious default; operator decides.         |

The boundary that matters is around twenty users, where "everyone in one audience" stops
being self-evidently right. Below it the household audience is the entire product. Above
it, an operator who disagrees turns it off and nobody is broadcast.

In every band the admin knows every user personally. That is load-bearing: it is why this
design has no blocking, no moderation tooling, and no restrictions on the user directory.
Those exist to defend against strangers, and there are none here. A user's controls over
other people are: leave the audience, hide an individual item, or set `hide_streams` and
disappear entirely. For a known population that is sufficient, and it is the reason
blocking is a non-goal rather than an open question.

Where scale-independence is free, take it: indexed membership lookups, a searchable rather
than enumerated picker, no N+1 in audience resolution, bounded fan-out on list surfaces.
Where it is not free — sharding, federation, digest batching, async invitation queues — do
not. The stated ceiling is **correct to ~1000, tuned for ~100**.

### The user directory is searchable — accepted risk

"No restrictions on the user directory" above is a real decision with a real cost, and it
should be readable as such rather than discovered by someone grepping `GET /users/search`.
Written 2026-08-11, when the endpoint was found to be bypassing every privacy control the
rest of this document describes.

**What the endpoint is.** `GET /api/users/search?q=` — autocomplete backing two pickers: the
admin access-group member picker on `/admin/settings/access`, and the playlist invite panel.
It is mounted only on the internal surface, and `/api/*` is forward-auth/cookie-only by
construction, so no PAT, service token or device JWT can reach it. The caller is always a
browser session that has already cleared the identity provider.

**The accepted residual risk**, stated plainly: any authenticated user can enumerate the
usernames of active, non-hidden accounts by typing prefixes. That follows directly from the
threat model above — the population is small and known to the operator — and hardening it
further would contradict "a searchable rather than enumerated picker" two paragraphs up.

#### Compensating controls

- **`hide_streams` reaches the directory.** A hidden user is absent from prefix search.
  They remain resolvable by **exact** username, deliberately: a plain filter would make them
  permanently un-invitable, which is a functional regression wearing a privacy costume.
  `hide_streams` means "do not surface me to people browsing", not "nobody may add me to a
  playlist when they already know my name".
- **Prefix, not substring, for peers.** Autocomplete works; "who here has 'an' in their
  name" does not. Admins keep substring search — they are entitled to the directory anyway
  via `GET /api/v1/users` (`users:admin`).
- **Dead accounts are never offered to peers.** Soft-deleted and disabled users are excluded,
  matching `getUsersByNames()`. Disabled accounts stay visible to admins on purpose: an
  operator fixing group membership needs to see the account that is disabled.
- **`FEATURE_PLAYLISTS=false` removes the peer-facing directory entirely** — the auth spec is
  `any(admin, feature:playlists → user)`, so a non-admin on such an install gets 404, not 403.
- **A 30/minute per-user rate limit** on the peer branch.

**The rate limit is not a boundary and must not be described as one.** At 30/min a two-letter
prefix sweep of the whole alphabet finishes in about a minute; it dampens casual scraping and
nothing more. A self-hosted install may have no reverse proxy or edge rate limiting at all. The real control is that the attacker is a named household member who is
accountable to the operator.

#### Operator guidance

This rests entirely on "the admin knows every user personally", and **this is the first place
that assumption breaks**. An install above roughly 100 users, or any install where users do
not know each other, should set `FEATURE_PLAYLISTS=false` — which removes peer invitations
and the directory with them — or accept that its users can enumerate each other. There is no
middle setting, deliberately: see the Non-Goals.

### The community-install profile

Everything above assumes a household. The defaults are chosen for one, and they are
deliberately open — but there is **no single switch that says "this install has strangers"**,
and that is a design decision rather than an oversight (a master toggle would have to guess
which of these an operator actually meant). So the recipe is written down instead.

An operator running a server whose users do not know each other should set all of these.
Each is independent, and each is safe to apply to a running install.

| Setting                              | Default | Set to   | What it stops                                                                              |
| ------------------------------------ | ------- | -------- | ------------------------------------------------------------------------------------------ |
| `SOCIAL_DEFAULT_AUDIENCE`            | `auto`  | `groups` | The household audience. With no group named this is the dark state — nobody sees activity. |
| `FEATURE_SESSIONS_PUBLIC`            | `true`  | `false`  | Every user seeing every other user's live stream, with title and progress.                 |
| `FEATURE_PLAYLISTS`                  | `true`  | `false`  | Peer invitations **and** the user directory — see the accepted-risk section above.         |
| `PLAYLIST_PUBLIC_GROUPS`             | `''`    | a group  | Anyone publishing a playlist visible to the whole instance (empty means unrestricted).     |
| `FEATURE_COMMENTS`                   | `false` | —        | Already off. Comments/reactions have no moderation queue and no reporting.                 |
| `FEATURE_SOCIAL` / `_SOCIAL_REVIEWS` | `true`  | `false`  | "Who watched/rated this" and community reviews on media.                                   |

Two notes that matter more than the table.

**The setup wizard's "Share activity between users" toggle covers the first two rows only.**
It writes `SOCIAL_DEFAULT_AUDIENCE`, and on the off path also `FEATURE_SESSIONS_PUBLIC`. It
does not touch playlists, public-playlist creation, comments or reviews — turning it off is
not the same as applying this profile.

**Turning these off does not delete anything.** They govern what is _disclosed_, not what is
_recorded_: watch history, playlists and existing comments survive, and re-enabling a flag
makes the same data visible again. An operator who needs data removed wants the GDPR erasure
path, not these switches.

Deliberately absent from this list: `FEATURE_WATCH_TOGETHER`. A party is opt-in on both sides
and its join is gated on the joiner's own media access, so it discloses nothing to someone who
was not invited into it. Turn it off if you do not want the feature; it is not a privacy lever.

## Current Model

Audiobook social visibility is decided in exactly one place,
`queries/builders/social-visibility.builder.ts`, which every social surface calls. It
enforces, in order: the subject has not set `hide_streams`; the subject is not the viewer
and is a live account (`deleted_at` / `disabled_at` both null); on audiobook surfaces
**both** subject and viewer have `share_audiobook_activity` on; for the coarse activity
tier both sides also have `share_listening_activity` on; the audience test (see below);
there is no `user_media_share_opt_out` row for that (subject, item); and the item is not
catalogue-dismissed.

**The problem this document set out to fix — since fixed.** `SOCIAL_TRUST_GROUPS` is empty
by default and empty means **off**, the inverse of every neighbouring group setting
including `SOCIAL_REVIEW_GROUPS` two entries above it in the schema, where empty means
_everyone_. The setting's own description has to warn about this. Turning listening-sharing
on therefore used to require the operator to enable the feature, create an in-app access
group, assign every user to it, and type that group's name into the setting — four steps,
one of them counter-intuitive, to let a family of four see each other. The `auto` audience
mode below removes all four for a fresh install; the inverted setting remains, but is no
longer the only way in.

Active Streams uses a separate operational pipeline. A viewer is restricted to their own
sessions unless `FEATURE_SESSIONS_PUBLIC` is set, they hold watch permission, or they are an
admin; other users' sessions are then filtered by the subject's `hide_streams`. Device
details are gated separately by `FEATURE_SESSIONS_DEVICE_INFO_PUBLIC`.

Playlist sharing is a resource ACL. An owner invites individual users into
`playlist_members` with a role and a `pending`/`accepted` status, and `getUserRole` gates
every playlist route.

Watch Together sessions are temporary synchronized-playback rooms with a host,
participants, public/private discoverability and a short-lived join code.

## Shipping Scope: the Household Audience

Status, so this section is not read as uniformly pending:

| Work                                           | State                                             |
| ---------------------------------------------- | ------------------------------------------------- |
| Admin "Sharing & Privacy" section              | **Done** — 2026-08-04                             |
| Household audience (`SOCIAL_DEFAULT_AUDIENCE`) | **Done** — 2026-08-04                             |
| User-facing privacy page                       | **Done** — 2026-08-04                             |
| Sharing-switch default reconciliation          | **Opt-in** — 16.350.0; preserves 16.189.0 choices |
| Per-item opt-out reaching Active Streams       | **Won't do** — deliberate, see below              |
| Reciprocity on both audiobook tiers            | **Done** — 2026-08-04                             |
| Admin audience-reach panel                     | **Done** — 2026-08-04                             |
| Audience covers movies/series, not just books  | **Done** — 2026-08-05                             |
| First-run audience disclosure                  | **Done** — 2026-08-05                             |

Two corrections to what this document previously claimed.

**The sharing-switch defaults were originally reconciled**, before this document was written.
Migration 16.187.0 aligned `share_listening_activity` to `DEFAULT true` and backfilled it,
matching `share_audiobook_activity`; 16.189.0 then added `privacy_prefs_updated_at` as an
explicit-choice marker with a standing contract: **any later migration that moves a privacy
default MUST scope its backfill to `WHERE privacy_prefs_updated_at IS NULL`**, so a default
change can never overwrite someone who deliberately opted out. `POST /user/stream-privacy`
sets that marker. The earlier claim here that the two defaults disagreed was stale. 16.350.0 now makes
all three switches private by default, preserving that marker contract (see below).

**Per-item opt-out will not be extended to Active Streams.** A hidden book still appears,
with its title, on the owner's live session card to anyone who can see sessions. This is
now a known and accepted gap rather than an oversight: per-item granularity on live
presence was judged more machinery than the behaviour is worth. The per-item control
continues to work everywhere else. Revisit only if someone actually reports it.

### The audience

The designated-group test inside `buildSocialVisibilityFilter` is now a resolved audience
with three modes, set by `SOCIAL_DEFAULT_AUDIENCE`:

- `household` — every user on the instance. No group test at all.
- `groups` — only users sharing a designated `SOCIAL_TRUST_GROUPS` entry (the historical
  behaviour, still dark when no group is named).
- `auto` — **the default.** `groups` when any group is named, `household` when none is.

The `auto` rule is the whole design, and it exists because the obvious alternative is
unsafe. Defaulting every install to `household` was the original plan here, on the
reasoning that an upgrade would widen the _potential_ audience while sharing nothing,
since each user's own switch stays off until they turn it on. **That reasoning was wrong**:
16.187.0 had already turned every switch on. On an install whose users left both sharing
switches at their defaults, a blanket `household` default would widen the audience from
a configured group to everyone in one deploy, without an explicit user choice.

So `auto` reads a named group list as what it is: a deliberate narrowing, which an upgrade
must not undo. A fresh install has no groups, gets `household`, and works with nothing to
configure — which is the failure this whole change exists to fix. An operator who wants
either behaviour explicitly can still say so.

An unrecognised value resolves to `groups`, so a typo in `settings.json` can only ever
under-share.

`SOCIAL_TRUST_GROUPS` keeps working for installs that already configured it, and remains
the escape hatch for an operator who wants the audience narrower than "everyone" without
waiting for circles. It stops being the only way in.

Nothing else in the predicate changes. `hide_streams`, self-exclusion, the audiobook
switch, activity-tier reciprocity, `user_media_share_opt_out` and catalogue dismissal all
survive untouched, and they remain the actual privacy controls.

That last point is the load-bearing argument for auto-populating the audience, and it
should not be lost: **membership in the household audience is not consent to share.** It
changes who is in the room, not whether you speak. Every switch a user had before, they
still have.

### Reciprocity applies to both audiobook tiers

The viewer's own `share_audiobook_activity` used to be checked only on the coarse
`'activity'` tier. A user who turned audiobook sharing off therefore stopped broadcasting
but kept receiving — and the ambient tier they kept receiving carries the _finer_ data
(exact resume position and chapter) while the protected one carries rounded durations and
day-level dates. The stated principle is "nobody reads behavioural data without exposing
their own"; it applies at least as strongly to the tier that exposes more, so it now holds
on both. A user who opts out loses the scrubber markers and shared-listen indicator, which
is the point: those are other people's positions.

### First run offers an operator audience

The wizard leads its Privacy group with **Share activity between users**, still
ON to match `SOCIAL_DEFAULT_AUDIENCE='auto'`. This enables a potential household
audience; it does not opt users into sharing. Every user starts private and chooses
their own switches in Settings → Privacy. Off writes `groups` with no groups named,
which is the dark state. The wizard copy distinguishes this operator choice from
the per-user defaults introduced in 16.350.0.

### The audience covers movies and series too

`getMediaViewers` gated audiobooks through the predicate and everything else on
`hide_streams` alone, so a user who narrowed their audience to one group still had their
whole watch history visible to every account on the instance — the one place "your
audience" did not mean what the Privacy page implies.

Both media types now go through the same audience. The audiobook arm additionally requires
`share_audiobook_activity` on both sides; the general arm does not, because that switch is
audiobook-specific. A row whose `media_items` record is missing takes the general arm
rather than skipping the check, which is the one behaviour change beyond the audience
itself.

This was previously blocked and is worth recording why it stopped being: with only
`SOCIAL_TRUST_GROUPS`, an install that never configured a circle resolved to `AND false`,
so routing movies through the predicate would have blanked the Community tab on every
default install. `auto` removed that — no groups now means household, not dark. What
remains is deliberate: an operator who explicitly picks "Selected groups" and names none
has said "nobody shares", and movies obey that like everything else. The admin panel warns
when the audience resolves to nobody.

Because the audience is no longer audiobook-only, the settings are named **Activity
Audience Mode** and **Activity Audience Groups** rather than "Listening".

### The admin can see the actual reach

The Sharing & Privacy section shows configuration, which is not what an operator needs to
know: "Automatic" plus a group list does not say how many people can see each other. A
panel under the section resolves the mode and reports how many users are in the audience,
how many are really sharing, and how many hid themselves — and warns when the audience is
**empty**, which from the settings alone looks identical to a working configuration.

Counts only, never names. It exists to make a setting's blast radius legible, and a name
list would be new disclosure for no added clarity.

### Sharing defaults — opt-in from 16.350.0

New users start private: `hide_streams = true`, `share_listening_activity = false`,
and `share_audiobook_activity = false`. The base schema and migration **16.350.0** set
these column defaults. The migration also resets existing users **only WHERE
`privacy_prefs_updated_at IS NULL`**. Users who saved any privacy preference keep all
three values, including explicit opt-ins. This preserves the standing 16.189.0
backfill contract; the historical unconditional 16.187.0 backfill must not be repeated.
The setup wizard still offers the operator a household audience, while each user
must enable their own sharing in Settings → Privacy.

`GET /media/{id}/listening-sharing` returns the named `SharingPolicy`:
`{shared, globallyShared, effectiveShared, audience, blockedBy}`. `shared` is the
per-item preference, `globallyShared` is the audiobook switch, and `audience` resolves
`SOCIAL_DEFAULT_AUDIENCE` to `household` or `groups` (`auto` without designated groups
means household). `blockedBy` contains every applicable reason, in order:
`global_sharing_off`, `hidden`, `item_opted_out`, `no_audience`.
`effectiveShared` is true only when that list is empty. Audience reach requires at
least one other live user; groups additionally require a shared designated group,
using the same live in-app/IdP membership union and SQL normalization as visibility.
Recipient privacy preferences do not change potential audience membership. PUT returns
the same policy after saving the item preference. The viewers response envelope is unchanged.

### Per-item opt-out does NOT reach Active Streams — accepted

`active-sessions-view.service.ts` filters on `hide_streams` and nothing else. It never
reads `user_media_share_opt_out`. So a user who hides one book from social sharing sees it
vanish from the audiobook surfaces while their live session — with that book's title on it
— continues to appear in Active Streams to everyone else.

This was considered and **deliberately not fixed**: per-item granularity on live presence
is more machinery than the behaviour justifies at these installation sizes. A user who does
not want a session seen has `hide_streams`, which is absolute.

Recorded here so it reads as a decision rather than a bug someone should quietly "fix".
The honest cost: the per-item control means "hidden from the activity surfaces", not
"hidden everywhere", and the UI should not imply otherwise. Revisit if a real user reports
being surprised by it.

### What deliberately does not change

**Active Streams visibility.** With `FEATURE_SESSIONS_PUBLIC` on, every user already sees
every other user's sessions minus `hide_streams` opt-outs — which is precisely what a
household audience would produce. Routing it through the audience predicate would rewrite a
working surface to yield identical behaviour at these sizes. The only change is the per-item
fix above. Administrative session visibility stays separate and unconditional: admins need
the operational view for stream management even when a subject shares nothing, and the UI
continues to mark those sessions as private.

**Playlists.** Playlists already have a real ACL with roles and explicit acceptance. An
audience would only add bulk invitation, which saves two clicks over a working flow. If
that ever becomes worth it, "invite all users" is a button and needs no audience concept
behind it.

**Watch Together.** Corrected 2026-08-11 — this section previously claimed its audience
modes were "public, unlisted with a code, selected individuals — already work". **The third
one does not exist.** There is no invitation, no allow-list and no participant pre-selection
anywhere in `watch-together.service.ts` or its route defs; `participants` are people who have
already joined, not people who were asked.

What actually exists is two states of one flag:

- `isPublic: true` (the default, `watch-together.service.ts:887`) — the session appears in
  `getAllSessions(publicOnly)`, which backs the homepage widget.
- `isPublic: false` — it does not appear in that listing.

**`isPublic` is discoverability, not access control, and the difference matters.**
`joinSession()` never reads it, and `POST /watch-together/{code}/join` gates only on
`FEATURE_WATCH_TOGETHER` + an authenticated user. So any account on the instance that has
the code can join an "unlisted" party. That is obscurity. It is defensible at these
installation sizes — the code is short-lived and the population is known — but it must not
be described as a private mode, because someone will eventually rely on the word.

The consequence for this document: circle-based invitation is not "a convenience with no
home in this scope". There is no invitation mechanism here for circles to plug into. If
Watch Together ever needs to invite a named person, that per-user invitation path has to be
built first, and it is a Watch Together question rather than a Circles one. See the Appendix,
which designs circle invitation on top of a substrate that does not yet exist.

### One privacy surface — implemented 2026-08-04

`hide_streams` and the two sharing switches lived inside the **Display** settings page,
between interface preferences and recommendation dampers. They are not display
preferences, and burying them there meant the person they protect had no single place to
read their own privacy state.

They now have their own **Privacy** section at `/settings/privacy`, presented in the order
the server's predicate actually evaluates them — `hide_streams` first as the master
opt-out, then the audiobook-wide switch, then the reciprocal coarse tier. Each dependent
switch renders disabled with a reason when something above it overrides it, rather than
silently doing nothing, so the page teaches the model instead of listing three unrelated
toggles. A closing note names the per-item hide as the fourth control, since it lives on
the book page and would otherwise be invisible here.

One behavioural detail worth keeping: every toggle stays disabled until the first read
lands. A privacy control must never be interactive while showing a value it has not read —
a click in that window would write the placeholder back, and `privacy_prefs_updated_at`
would then record the accident as an explicit choice.

### The admin surface: a Sharing & Privacy section — implemented 2026-08-04

The operator side had the same problem, and worse. The settings deciding what users expose
to each other were split across two pages by an accident of history: `FEATURE_SOCIAL`,
`FEATURE_SOCIAL_REVIEWS`, `SOCIAL_REVIEW_GROUPS` and `SOCIAL_TRUST_GROUPS` sat in
`features` on the main settings page, while `FEATURE_SESSIONS_PUBLIC` and
`FEATURE_SESSIONS_DEVICE_INFO_PUBLIC` sat in `streaming` on the **Playback** page, between
transcoding and device settings. `FEATURE_SESSIONS_PUBLIC` is the single most consequential
privacy switch on the instance — it decides whether users see each other's live sessions at
all — and no page named the question it answers.

The four `features` settings now live in a **`social` section labelled "Sharing & Privacy"**,
order 12.5, directly after Permission Groups on `/admin/settings`. A section, not a new
route: the value is their appearing together under a heading that names the question, not a
dedicated URL. Its `helpText` draws the line this document draws — Permission Groups
governs what a user may ACCESS, this section governs what other users may SEE about them —
and states that every switch here sets the widest an audience can be, with per-user and
per-item controls always winning.

**The two session-visibility settings could not move, and the reason is a hard constraint
worth recording.** `dependsOn` cannot cross a section boundary: `isSettingEnabled` evaluates
`values[setting.dependsOn]`, and `values` only ever holds settings from the sections the
current page loaded, so a parent in another section reads as `undefined` → falsy → the child
renders permanently disabled with no way to enable it. `validateSchema()` rejects this
outright ("This setting will NOT appear in the admin UI").

Moving the parent instead is worse: `FEATURE_SESSIONS` also parents
`SESSIONS_REFRESH_INTERVAL_MS` and `SESSIONS_POLL_INTERVAL_MS`, polling knobs with no
business in a privacy section — relocating it would simply move the breakage onto them. So
`FEATURE_SESSIONS_PUBLIC` and `FEATURE_SESSIONS_DEVICE_INFO_PUBLIC` stay under `streaming`
on the Playback page, and the Sharing & Privacy `helpText` names where they live instead.
That is a genuine residual wart: the instance's most consequential privacy switch is still
one page away from the section about privacy. Closing it properly needs either
cross-section dependency support or a rethink of what `streaming` is for.

Two decisions that look like omissions and are not. Each has a comment at the site so it
does not get "fixed":

- **No section-level `featureFlag`.** `SettingSection.svelte` disables every setting in a
  section whose flag is off (`disabled = !featureEnabled ? true : …`), so pinning
  `FEATURE_SOCIAL` there would disable the whole section for an operator who turned social
  features off — including anything later added that `FEATURE_SOCIAL` does not govern.
- **No `SOCIAL_DEFAULT_AUDIENCE` yet.** The household audience it would control does not
  exist. Shipping the knob first would put a setting in the admin UI that does nothing.

Also unchanged: the Watch Together timing knobs (operational) and `FEATURE_PLAYLISTS`.

Three constraints, all load-bearing for anyone adding a section later:

- A section absent from `ADMIN_SETTINGS_PAGES` becomes an orphan — unreachable from
  cross-page settings search, as `requests` and `licensing` are today.
  `admin-settings-pages.test.ts` enforces "claimed by exactly one page OR marked orphan",
  so this fails loudly. The page's own `SECTION_IDS` needs it too, and that one does not.
- The Access page resolves origin chips through a hardcoded `SECTION_ORIGIN` map keyed by
  section id, and `originChipFor` returns `undefined` for an unmapped section. Because
  `SOCIAL_REVIEW_GROUPS` and `SOCIAL_TRUST_GROUPS` appear in its group-rules audit panel,
  moving them without adding a `social` entry would have dropped their origin chip
  silently, with no error and no test failure.
- No setting may be separated from its `dependsOn` parent, per the constraint above.
  `validateSchema()` catches it, but it only ever printed to `console.warn` on module load,
  so the first version of this change shipped a broken `FEATURE_SESSIONS_PUBLIC` past unit
  tests, `svelte-check` and `eslint --max-warnings=0` — the warning was visible only in
  `npm run dev` startup output. `schema.validate.test.ts` now asserts the validator is
  clean, so it fails in CI instead.

When `SOCIAL_DEFAULT_AUDIENCE` lands it belongs in this section, non-`advanced`, with its
`config.ts` getter and `schema.ts` entry in the same commit — the schema-parity lint rule
reads the filesystem outside the cache graph and will fail otherwise.

## Identity Backends

Group membership means three different things here, and any design that leans on it
inherits whichever one the install happens to use.

| Backend      | Source of `users.groups`                             | Freshness                  |
| ------------ | ---------------------------------------------------- | -------------------------- |
| Forward auth | `GROUPHEADER` per request, via `upsertUserGroups`    | Fresh on every request     |
| OIDC         | `AUTH_OIDC_GROUPS_CLAIM`, synced at login            | Stale until the next login |
| Native auth  | Nothing for regular users; `ADMIN_GROUPS` for admins | Effectively absent         |

Three consequences constrain everything above and below.

**Group-derived membership cannot revoke promptly.** Under OIDC, removing a user from a
group in the IdP has no effect until their next login. Sessions are long and TV clients on
refresh tokens may not traverse the login path for weeks. An audience whose _removal_ is
delayed indefinitely is not a privacy control. This is the strongest argument for a
database-backed audience over an IdP-derived one, and it applies to `SOCIAL_TRUST_GROUPS`
today: a household audience resolved from the user table revokes immediately, a group-based
one does not.

**Group-derived audiences must stay computed, never materialized.** Snapshotting group
membership into a table yields doubly stale data — a stale IdP projection frozen into a
stale copy. The current builder resolves effective groups in SQL for both sides at read
time; anything derived from groups must keep doing that.

**Groups are matched by name, not identity.** Names are case-folded by Postgres `lower()`
on all three sides deliberately, because pre-folding in JS disagreed with `lower()` under a
C-locale database and silently emptied an entire configured circle. But a rename in the IdP
still empties it, with no error and no log. A household audience resolved from user rows
has no such failure mode; anything group-derived does.

Finally, forward auth and OIDC both write `users.groups` and overwrite each other. A user
arriving via OIDC on the web and forward auth on a TV, with differing group sets, gets
membership that flaps. The configuration schema already advises choosing one primary front
door; for group-derived audiences that advice is a requirement.

## Notifications

**Built. See [`user-events.md`](./user-events.md)** — it is canonical for the taxonomy,
emitters, subscription model, client contract and delivery surfaces. Do not re-decide any
of that here.

Kept only because this section previously named three defects and a future reader deserves
to know what happened to them rather than go looking:

1. **Advertised-but-dead event types — resolved, and better than proposed.** Eleven kinds
   were advertised on `GET /api/v1/server` and seven had no emitter anywhere.
   The first fix here simply pruned the list to what emitted. The real fix replaced the
   flat list with an `events.kinds` taxonomy carrying `class`
   (`notification` | `signal`), `durable`, per-install `available` and an
   `unavailable_reason` — so a client can finally distinguish "this server does not
   support it" from "supported but quiet", which the flat list could never express.
   `event_types` survives as a deprecated projection for one release.
2. **Cross-pod live delivery — built.** Frames now fan out over a Valkey pub/sub channel,
   and the local broadcast was moved _into_ the subscriber so there is exactly one delivery
   path rather than a local one plus a remote one that could disagree.
3. **The request popup — partially folded into the inbox.** See the section of the same
   name in `user-events.md` for what moved and what did not.

Nothing in the household-audience scope above emits a notification: an implicit audience
has no invitations to deliver. That stays true. If Circles are ever built, `social.invite`
is the kind they would need, and it would earn its place in the taxonomy by gaining an
emitter — not by being listed in advance, which is the mistake this whole section records.

Note that `media-added-notifier.service.ts` is not this. It fans `media.becamePlayable`
into `org.lumastra.media.item.added` CloudEvents for operator-configured webhooks — an
outbound integration surface, not a user inbox.

## Non-Goals

- A public follower graph, timeline, messaging, or user discovery network. (Corrected
  2026-08-11: this line previously also said "reactions". Comments and reactions ship on
  media, playlists and people via the `interactions` / `interaction_reactions` tables — see
  `user-events.md`, "Killed" — so listing them as a non-goal contradicted the code. They are
  unused, not absent; the non-goal is a follower graph _around_ them, not the endpoints
  themselves.)
- Anti-enumeration hardening of the user directory beyond the compensating controls named
  in "The user directory is searchable" — for the same reason blocking is a non-goal. A
  CAPTCHA, an opt-out-of-being-findable flag, or a per-install directory ACL would each add
  a permanent privacy state to reason about in defence of a population that is already
  accountable to the operator.
- Blocking, muting, moderation tooling or invitation-abuse defences. The population is
  small and known to the operator; leave, per-item opt-out and `hide_streams` are the
  user's controls, and the operator is the escalation path.
- Treating administrative access groups as user-owned social audiences.
- One generic polymorphic ACL engine for every social and authorization feature.
- Granting session-management permissions through audience membership.
- Automatically joining or starting playback for anyone.
- Removing direct user invitations or per-item privacy controls.
- Cross-instance federation of audiences or activity.

## Open Decisions

- Whether Active Streams should share exact or deliberately rounded progress. Audiobook
  activity already rounds durations and uses day-level dates; matching that is consistent
  and removes a knob.
- Whether a user may leave the household audience, or only mute themselves within it via
  the existing switches. Leaving is more honest; the switches already achieve the same
  visible result.

## Appendix: Deferred Design — Circles

Retained as the design of record. Not scheduled.

### Why it is deferred

The reuse argument — one audience concept shared by audiobook activity, Active Streams,
Watch Together and playlists — gets strong at a few hundred users with genuinely distinct
sub-groups. Below roughly twenty, there is one audience and it contains everyone. Building
invitation, acceptance, ownership, membership management and a shared picker to express
that is a large permanent surface for no expressed need, and privacy surfaces are the worst
place to carry unused states: every combination of `hide_streams`, dimension switch,
reciprocity, per-item opt-out, N audiences and three identity backends is a combination
where something can leak or silently blank.

Deferral is cheap specifically because `buildSocialVisibilityFilter` already exists as the
single choke point. Introducing circles later changes the internals of one file rather than
four query modules and every consuming surface.

### What would revive it

A concrete request from a real install for a _second_ audience — "I don't want the kids
seeing my activity", "my book club shouldn't be in with family". That is the only evidence
that distinguishes this from a feature designed for a user who does not exist yet.

### The model

A circle is a named, user-managed sharing audience with a stable ID and user-visible name,
one or more owners who manage membership, members in `pending` or `accepted` status,
explicit invitation and acceptance, and leave, remove-member and delete flows.

Circle membership must not grant administrative capability. Circles must not reuse
`access_groups` or `user_access_groups`; those remain part of the authorization system.
Beyond the authorization argument, the identity-backend constraints above apply: an
IdP-derived audience cannot revoke promptly, cannot survive a rename, and cannot offer the
stable ID a circle promises.

**Users belong to multiple circles.** That is the point of the feature, and it forces four
decisions:

1. **Union semantics.** A subject is visible if the viewer is in _any_ circle the subject
   selected for that dimension. Intersection is nobody's mental model.
2. **Dedupe is mandatory.** Someone in two shared circles matches twice. List surfaces must
   return one row per subject. The current predicate uses array overlap, which dedupes
   naturally; a membership join does not, and will multiply rows unless written as an
   `EXISTS`.
3. **Audience selection is per-dimension, not per-circle.** The table is
   `user_share_audience(user_id, dimension, circle_id)` — for each dimension, a set of
   circles. Naming it up front decides whether per-dimension audiences are a migration or a
   no-op later.
4. **Reciprocity is evaluated on the global dimension switch, not on symmetric circle
   selection.** A sees B when B selected a circle containing A _and_ both have the
   dimension switch on. The alternative — requiring symmetric circle choice — produces "we
   are both in Family, why can't I see her?" with no answerable explanation.

Per-circle _dimension_ switches are a further step and should not arrive with the rest.
Plural membership is cheap; a per-circle by per-dimension matrix is a settings screen
nobody at this scale will open.

Invitation rights are per-circle: owner-managed by default with a `members_can_invite`
flag. A household wants everyone inviting; a curated book club does not.

### Sharing semantics if built

**Audiobook activity.** Users select which circles receive their activity. The layered
controls remain: share nothing, share with selected circles, enable or disable the coarse
activity tier, hide an individual book regardless. Exact timestamps stay private; shared
activity keeps rounded durations and day-level dates.

**Active Streams.** Live presence is more sensitive than historical coarse activity, so it
is an explicit sharing dimension rather than an automatic consequence of joining a circle.
A user always sees and can stop their own sessions. `hide_streams` remains a master
opt-out taking precedence over every selected circle. The social card may show title,
play/pause state and approximate progress; device identifiers, browser names, IP addresses
and upstream session IDs are never exposed through membership. Per-item suppression hides
the corresponding live session. Circle membership never grants stop-stream or
session-administration rights.

**Watch Together.** ⚠️ **This subsection designs on top of a substrate that does not
exist.** Watch Together has no per-user invitation path at all today — only a join code and
a listing flag (see "What deliberately does not change" above). Everything below presumes
individual pending invitations are a thing that can be created; building that is a
prerequisite, not a detail, and it is independently useful without circles.

Circles are reusable invitation targets, but a circle is durable
membership and a party is a temporary room; they stay separate objects. Inviting a circle
creates individual pending invitations for its currently accepted members. Nobody joins or
starts playback automatically. Every invitee accepts explicitly and must still pass media,
library, group and age checks. People who join the circle later do not gain access to a
running party. Removing someone from the circle does not eject them from a party they
joined — the host uses participant controls — and it does not revoke invitations already
sent; those stand until accepted or declined. Membership grants no host, seek, moderation
or host-transfer rights.

**Playlists.** Roles remain resource-specific ACLs; membership alone grants nothing.
"Invite circle" creates an individual pending invite per accepted member at that moment, so
recipients still accept, existing role checks stay authoritative, someone joining later
does not receive old playlists, and leaving does not revoke independently accepted access.
Dynamic sharing with all current and future members could be added later as an explicitly
different mode, never the default.

### System circles are a weaker object

`SOCIAL_TRUST_GROUPS` could be presented as read-only system circles. Such a circle is
keyed by name rather than identity, so an IdP rename empties it silently; its membership
revokes only as fast as the identity backend refreshes; and it cannot be renamed or left.
It does not satisfy the stable-ID guarantee real circles offer, and the doc should not
pretend otherwise.

A better migration path is **seed-from-group**: an admin creates a real circle and
populates it once from an IdP group. Members become genuine members with acceptance and
stable IDs, the install keeps the convenience of its existing structure, and
`SOCIAL_TRUST_GROUPS` can eventually be retired rather than supported indefinitely.

### Rollout if revived

The household audience is already step one and already shipped, which is why this ordering
differs from the original plan: building circle CRUD before any surface consumes it
produces an empty feature users cannot evaluate.

1. User-managed circles, invitations, acceptance, membership management. Delivery is
   solved: add a `social.invite` descriptor to the shared kind taxonomy
   (`$lib/shared/user-event-kinds.ts`, `class: 'notification'`, `durable: true`) and an
   emitter beside it. The hub, the durable inbox, cross-pod fan-out and the client
   contract already exist — see [`user-events.md`](./user-events.md). A descriptor with
   no emitter is the one thing not to add; that is the mistake the Notifications section
   above records.
2. Circle audiences for audiobook activity, alongside the household audience.
3. Circle-scoped Active Streams sharing, without changing own-session or administrator
   visibility.
4. The reusable individual-or-circle audience picker, worth building only once more than
   one circle exists.
5. Circle-based Watch Together invitations that materialize individual pending invitations.
6. Circle-based bulk playlist invitations that materialize individual pending invites.
7. Per-circle sharing dimensions, only if users need more control than the global and
   per-item switches provide.

Deletion and export must be handled with the first step, not last: circles are personal
data, and deleting a user has to resolve ownership of any circle they own. That forces
ownership transfer to exist, or deletion to cascade. Child accounts need a stated policy on
creating circles and accepting invitations before the tables exist, since the codebase
applies age filtering everywhere else.
