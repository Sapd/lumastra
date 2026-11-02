# plugins/

External-plugin loader + a few domain-specific submodules used by native builtins.

All builtin plugins are SDK natives — they register against `defineTask` / `defineProvider` / `defineTrickplayProvider` / `defineWatchSync` / `defineFeature` / `defineIntegration` / `defineExternalService` / `defineMediaSource` / `defineSubtitleProvider` from `@sapd/lumastra-plugin-sdk` and live under `src/lib/server/tasks/builtin/native/`.

## Files

| File       | What                  | When to read                   |
| ---------- | --------------------- | ------------------------------ |
| `index.ts` | Plugin system exports | Importing plugin functionality |

## Subdirectories

| Directory   | What                                                                                                                                                                                                      | When to read                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `external/` | External plugin discovery + drop-in references (hello-world, example-feature-plugin).                                                                                                                     | Loading third-party plugins                |
| `holidays/` | Holiday recommendation data sources + config loader; consumed by `tasks/builtin/native/features/holiday-recommendations.ts`                                                                               | Holiday-themed recommendations             |
| `kavita/`   | Kavita manga-server client wrappers; consumed by `tasks/builtin/native/media-sources/kavita.ts`                                                                                                           | Kavita manga integration                   |
| `runtime/`  | External-plugin loader, field-authority loader, drain-backlog helpers, admin DTO                                                                                                                          | Understanding plugin loading + admin views |
| `types/`    | Typing handles for the `PluginContext` shape internal services use, plus re-exports of domain types from `providers/types` and the SDK. Not plugin contracts — those live in `@sapd/lumastra-plugin-sdk`. | Working with internal service typings      |

## Plugin tables and the GDPR registries

- **A table a plugin creates itself (`ensureSchema`) is not in the GDPR registries.** Feature plugins
  have no migrations, so their tables never show up in `ERASURE_TABLE_REGISTRY` or
  `EXPORT_TABLE_ALLOWLIST` (`database/queries/gdpr-*.queries.ts`) unless you add them. The coverage
  guards read the live schema, but only see a plugin table when some test creates it. Erasure still
  works for a table with an `ON DELETE CASCADE` foreign key to `users`; the data export does not, and
  fails silently. When a GDPR guard names an unknown table, grep `plugins/` before calling it stale.
- **Naming a table on the export allowlist is a claim.** Add the section, query and assembly too, or
  the export lies. Aggregated, self-resetting counters (one row per user per day) can be excluded; an
  event log with exact timestamps that nothing prunes is personal data. Check for a `DELETE` in the
  plugin before reusing the "transient counter" reasoning.

## Trust Boundary (current state)

1. **Plugin installation = admin trust.** Operators are responsible for vetting plugins before install. Installing an untrusted plugin is equivalent to running `npm install` with a malicious `postinstall` script.
2. **`ctx.sql` is the global DB pool.** Plugins can read any table. There is no per-plugin row-level isolation. Future work: scoped DB role.
3. **No vm/isolated-vm sandbox.** Plugins run in the host Node.js process with full API access. Future work: vm2 or isolated-vm.
4. **`ctx.http`** — defaults to unrestricted outbound fetches (rate-limited, SSRF syntactic guard applied). Plugins opt in to a domain allowlist via `capabilities.allowedDomains: ['api.example.com']`; the allowlist is enforced in `buildHttpClient` (context-primitives.ts).
5. **Secrets isolation** — `ctx.secrets.get(key)` scopes to the calling plugin. Plugins with `capabilities.database: true` can query `plugin_secrets` directly via `ctx.sql` (see caveat 2).

## Typed Stores (`ctx.playlists`, `ctx.mediaSegments`)

`tasks/plugin-stores.ts`. Both operations were already _possible_ via `capabilities.database` + raw SQL — smart playlists and intro detectors are the two most obvious plugin shapes the system could host — but raw SQL is not a contract: it works until a column moves, bypasses host invariants, and gives an author no signal about which tables are safe.

- **`mediaSegments`** keys on `(media, type, source)` with the **plugin id as source**, so one detector can never overwrite another's findings and its own are removable without touching theirs. Segments with `endTime <= startTime` are dropped with a warning — that is a detector bug that reaches the player as a skip button doing nothing.
- **`playlists.replaceItems`** is the smart-playlist primitive: recompute the set, hand it over. It runs as ONE transaction because delete-then-insert in two steps leaves the playlist briefly empty, and a viewer opening it in that window sees their playlist wiped. Ids that do not resolve are dropped, which is right for a recomputed set.

Adding a required field to `TaskContext`/`PluginContext` breaks every hand-rolled context — the mock context, the worker runner, and any test literal. That is the bug class `tasks/CLAUDE.md` warns about, and it surfaced immediately here. The testing package stubs both stores so a plugin test asserting "these items should be in this playlist" never needs Postgres.

## Plugin-owned Pages (`/p/<featureId>`)

`FeatureDefinition.pages` serves a plugin-owned page inside the normal app shell, optionally with a sidebar entry. Requires `capabilities.browserUi` — a page runs plugin JS in the host document exactly as a widget does. Data still comes from the plugin's own `/api/plugins/<id>/*` routes, so a page adds **no new server dispatch surface**.

- **⚠️ NOTHING STATIC MAY EVER BE ADDED UNDER `src/routes/p/`.** A static sibling permanently shadows any plugin whose feature id matches it, and the author cannot discover why their page 404s. `/api/plugins/*` already has this problem (its static children silently reserve those ids), which is exactly why this namespace was created fresh instead of nested there. `plugin-page-namespace.test.ts` pins that the directory keeps exactly one child.
- **Access is enforced in the page load, and a denial is 404 — not 403.** A 403 confirms the page exists, which tells an unauthorized viewer which plugins are installed. The nav filter is the cosmetic half: it stops the sidebar advertising doors that 404, and re-deriving permission in the component could only disagree with the load that actually enforces it.
- Nav entries carry a stable synthetic key (`plugin:<featureId>:<pageId>`); the sidebar's own keys are index-composed and would reshuffle. Plugin entries join BOTH the top-level and section-children paths — a page declaring a `section` would otherwise be filtered out of top-level and never appear in its section.

## Player Overlay (`placement: 'player'`)

The riskiest surface, so the containment is **structural, not advisory** (`components/plugins/PluginPlayerRegion.svelte` + `components/player/plugin-playback-bridge.ts`):

- The region sits at a z-index BELOW the host controls layer. A plugin cannot cover pause/seek/back however it styles itself — its DOM is nested inside, so there is no value it can set that wins.
- Container is `pointer-events: none`; a plugin opts individual elements back in. Default state of plugin DOM is "does not intercept the click aimed at the video". An opened `panel` IS the interaction target, so that one enables them.
- `contain: layout style paint` — a plugin's layout cannot thrash the player's.
- `panel` (the default region) renders NOTHING until the viewer opens it, so an installed player plugin costs nothing during ordinary playback.

**The bridge is pull/observe only.** `getSnapshot()` + `subscribe()` at ~2Hz plus edges (play/pause/seek/item change). Edges bypass the throttle — a plugin showing "playing" must not sit on it for half a second. Callbacks are wrapped, and **three CONSECUTIVE throws disarm the subscriber for the session**: there is nobody at the keyboard to fix a plugin mid-film, and one throwing per tick would burn CPU and fill the console for the whole runtime. A good tick clears the streak, so an intermittent failure is not treated as a broken subscriber. `notify()` short-circuits entirely when nobody is subscribed.

What never crosses: the `<video>` element, the hls instance, any stream URL (they carry session material), the player store. `mediaItemId` + position covers every catalogued use case.

## Home Sections (`homeSections`)

`runtime/home-sections.ts`. A plugin returns **ids, never items** — that IS the design. The host resolves them through the viewer-scoped path, so a plugin physically cannot surface media the viewer's library scope or age rating hides: access control is not something it opts into, it is something it cannot opt out of. The host also renders the row with its own section renderer, so a contributed row looks native and reaches every client with no plugin JS in the page.

Budgets: 500ms per feature (larger than the badge budget — once per page load, not per rail), 3 sections per feature, 30 items each. **A section whose every item is hidden from this viewer is dropped, not shown empty** — an empty rail reads as a broken feature rather than as one with nothing to say today.

## Widget Placements

`home` (grid) · `below-hero` (banner) · `detail` (media detail modal) · `settings-user` (settings → connections, where a scrobble connector's "link my account" UI goes — the per-user credential store existed with nowhere for a user to populate it).

Every surface filters with an **allowlist** on placement. A denylist admits each newly-invented placement into whichever surface used it, which is the bug the home grid and both of its config editors shipped with.

## Card Badges (`decorateCards`)

A **data** hook, not a UI mount point — `runtime/card-badges.ts`. A browse grid renders hundreds of cards, so per-card third-party JS would be a performance disaster and could never look native. Merging server-side instead means a plugin's badges reach EVERY client (web, iOS, tvOS, `/api/v1`) with no browser code, and access control stays host-side.

**Wired in `runRecommender`**, immediately after the per-user translation overlay and for the identical reason documented there: it is the single entry point every strategy funnels through, so one insertion covers `/feed` and every Tier-2 rail. It sits AFTER `strategy.fetch()`, so it is post-cache by construction — what strategies persist stays plugin-neutral.

Bounds, all of which exist because this is the hottest read path in the app: 50ms per feature (matched to the home SSR overlay budget), concurrent fan-out (serial would make the worst case the SUM of every plugin's latency), full fault isolation, output validated against the host's own `BadgeSchema`, ids the host did not ask about ignored, and **3 badges per item** maximum across all plugins.

`badges` on `ForYouRecommendationItemSchema` is at the ITEM level, like `isAvailable`: the response conformance strip in `mount.ts` drops any key not on the schema, so a field declared in the wrong place is silently deleted in production. `.optional()`, never `.nullable()` — a required field is a one-way door for strict Swift decoders.

## Plugin Catalog / Repositories

`schemas/plugin-repository.ts`, `services/plugin-repository.service.ts`, migration `16.233.0`.

**A repository IS a URL serving one JSON index, and it grants ZERO trust.** Each entry carries the `(manifestUrl, signature)` pair an operator would otherwise paste, so installing from the catalog calls the SAME `installExternalPlugin` with the SAME inputs. The catalog is an **autofill for the verified install form** — which makes a trust bypass structurally impossible rather than policy-enforced, and means every hardening already shipped (SSRF, caps, signature, ABI, anti-rollback, key continuity) covers a catalog install for free.

Everything an index says is therefore **advisory** — `sdkAbi`, `keyId`, descriptions — and re-derived from signed bytes before install. A lying repository produces a clean install failure, never a bad install. The browse UI must label advisory trust as _claimed_ and use the preview endpoint for verified fact at the decision moment.

- **`plugin_repositories` is admin-UI writable, unlike trusted keys**, and that difference is the argument: adding a repository changes what is ADVERTISED, never what can run. Keys stay env-only because a settings write there WOULD be code execution.
- **No cross-repository merge, no priority order.** Identity is `(repository_id, name)`; two repos offering `trakt` are two labelled rows. Priority lists are the config nobody understands in five years, and the takeover risk is already closed by signing-key continuity.
- **Update matching requires name AND key match.** Otherwise any repository could advertise "updates" for plugins it does not publish — notification spam that grooms an operator into force-installing a stranger's build. A NULL installed key is never offered catalog updates: nothing to match against.
- **Zero repositories configured (the default) ⇒ zero outbound requests.** Adding one IS the consent to poll it; there is no hidden update endpoint and no telemetry.
- **The index is unsigned in v1, slot reserved.** Per-manifest signatures carry all code-execution trust; index signing would add authenticity for cosmetic metadata and partial protection against update SUPPRESSION — but suppression is a freshness problem a bare signature does not solve (a replayed signed index is valid). That needs signed timestamps with expiry, which is its own reviewed increment. Shipping half the guarantee is worse than none. The cheap mitigation — displaying index age — ships now.
- A `schemaVersion` newer than this host understands is REFUSED rather than parsed: a half-understood index is worse than none.

## Install Preview (dry run)

`previewExternalPlugin` + `POST /api/admin/plugins/external/preview`. Fetches and verifies the MANIFEST only — no bundle fetch, no writes — and reports what an install would do: the manifest as actually signed, the key that actually verified it (never the manifest's advisory `keyId`), and the same version / key-continuity / ABI verdicts in the same ORDER the install path reaches them, so the preview can never say "fine" about something that then fails.

Its point is that every value an operator reads in a confirmation is verified rather than claimed — which is what stops a future catalog from being able to lure a click with false metadata. It already improves the manual paste-a-URL flow from "install and find out" to "look, then install". Adds no capability: same admin auth, same guards, a strict subset of what install does.

## Signed Catalog Metadata + Capability Bound

The manifest carries `publisher`, `description`, `license`, `sourceUrl`, `capabilities`, `minAppVersion`, `releasedAt` — all optional (pre-existing manifests install byte-for-byte), all **inside the signature**.

**The split rule:** a field is signed if a malicious catalog substituting it could get an operator to install something they otherwise would not. Presentation — pretty title, icon, screenshots, download counts, long README — is NOT signed and belongs to a catalog index. "Harmless theme" over a watch-sync-with-database bundle is exactly the swap the signature has to prevent.

**`capabilities` is the important one.** Until now capabilities were only knowable AFTER the bundle's top-level code had already run with full host trust (`readBundleCapabilities` reads the loaded definitions), so there was nothing signed to show at the moment the operator decides. Now the manifest declares them and `capabilitySubsetViolation` enforces the declaration as an **upper bound** after load: a bundle registering more than it declared is refused + rolled back (422). Upper bound, not equality — declaring what you don't use is merely cautious. The check necessarily runs after the offending code has executed; rollback removes it from disk and registry, but cannot un-execute it. That is the standing no-sandbox caveat, not a new one.

**`ExternalPluginManifestSchema` must never become `.strict()`.** Zod strips unknown keys, and the signature is verified over raw bytes BEFORE parsing — which is what lets a manifest signed with fields a future host understands still install on an older one. A test pins this.

Persisted as one `external_plugins.manifest_metadata jsonb` (migration `16.232.0`) rather than a column per field: it is a verbatim copy of what was signed, read as a unit for display, and the field set will grow.

## Signing-key Continuity (upgrade takeover)

`signingKeyContinuityRejection` in `external-install/installer.ts` refuses an upgrade signed by a different key than the one that installed the plugin (409, forceable).

**The attack it closes.** Signature verification tries the WHOLE effective trusted set and asks only "is this signed by someone I trust" — never "is this signed by whoever I got this plugin from". So an operator trusting two keys (two community repos) had nothing stopping the second key's owner from publishing under the first one's name at a higher version: both signatures verify, and anti-rollback does not help because the attacker publishes a _higher_ version. The result was a silent publisher swap on code that runs with full host trust.

The rule is application-store signature continuity: name→key is pinned at first install. Rotation is legitimate, so `force` overrides — as an explicit operator decision, with the audit log recording BOTH key ids (`keyId` + `priorKeyId`). A NULL prior key (legacy/pre-migration row, or a registry-less drop-in) pins nothing and is not enforced.

This matters more once a catalog exists — two repositories both offering `trakt` stops being a takeover vector and becomes mere UI duplication — but it is worth having independently, since the manual paste-a-URL path has the same exposure.

## Playback Events + Veto

**Events.** `org.lumastra.playback.started` / `.paused` / `.resumed` / `.stopped` publish from `PlaySessionLifecycleService` (`notifySessionStarted` and `update`). Two decisions worth keeping:

- **Plugins only, never the operator webhook outbox.** An operator hook with an empty `event_filter` means "send me everything", so routing playback through `WebhookOutbox.enqueue` would start flooding every existing hook with an event per heartbeat the moment it shipped.
- **Pause/resume are EDGES.** A client heartbeats every few seconds, so the tap publishes only when `payload.status !== session.status`. Publishing on every ACTIVE tick would drown a subscriber in duplicates.

`PLUGIN_EVENT_TYPES` in `runtime/integration-events.ts` is the published catalogue and is pinned by a test — `subscribes` matches by exact string, so a rename silently turns a working notifier into one that receives nothing.

**Veto.** `IntegrationDefinition.authorizePlayback` lets a plugin refuse a stream (`runtime/playback-authorization.ts`), alongside — not instead of — the host's native `enforceStreamPolicy`. A refusal surfaces as the `plugin_denied` PolicyError kind.

- **Runs BEFORE the session transaction**, never inside it. `enforceStreamPolicy` holds `SELECT … FOR UPDATE` while it counts active sessions; third-party code under those locks would let one slow gate stall every other viewer's session start.
- **Fails OPEN** — a throw, a hang past 2s, or a malformed verdict is ignored. A policy that stops being enforced is a bad afternoon; a media server that refuses every stream because a plugin broke is an outage. Only an explicit `{ allow: false }` denies; the host never guesses at intent.

## Auth Providers (the narrowest contract)

`defineAuthProvider` + `services/plugin-auth.service.ts`. The most dangerous contract here, so it is deliberately the narrowest.

**It is a credential VERIFIER and claims source, never a gate.** Invoked only during an explicit login attempt on a dedicated route; it returns a verdict and the HOST maps identity, decides provisioning, builds permissions, mints the session and sets the cookie. There is **no per-request hook of any kind** — no middleware, no claims enrichment, no session-validation callback. A provider that hangs breaks its own login button and nothing else. That rejection is the core of the design: any request-path seam turns "plugin bug" into "site-wide incident".

**Installing one changes NOTHING.** Three env-only gates, all defaulting to EMPTY:

| Gate                       | Grants                             |
| -------------------------- | ---------------------------------- |
| `AUTH_PLUGIN_PROVIDERS`    | may be a login method at all       |
| `AUTH_PLUGIN_PROVISION`    | may CREATE accounts on first login |
| `AUTH_PLUGIN_ADMIN_ASSERT` | asserted groups may confer admin   |

That inert-by-default posture is the _condition_ under which this contract is defensible — it puts "who can log in" back at deploy-time trust, the same act and tier as configuring an OIDC issuer, rather than making it a consequence of installing a plugin. Env-only for the established reason: a settings write must never become an auth-perimeter change. They are also the escape hatch — removing an id closes that surface on the NEXT REQUEST, with no restart and no dependence on restart-only unload.

**FAILS CLOSED**, explicitly opposite to `authorizePlayback`: a playback veto fails open because a broken plugin refusing every stream is an outage, whereas an auth check that fails open is an authentication bypass. Throw, timeout and malformed verdict all become `unavailable`.

Other load-bearing rules: `capabilities.database`/`browserUi` are REFUSED by the validator (no raw-SQL rationale exists for a verifier; and a plugin that could script `/login` could harvest the native password field). The verdict has no `userId` field — a provider cannot say "log this person in as X", only "these are the claims I verified". Identity binds on `(plugin:<id>, subject)` in the existing ledger; **the returned `username` is a provisioning hint and never a lookup key** (this codebase has been burned by username-as-key). Admin groups are stripped from every login unless separately granted, and a provisioned account is `isAdmin: false` regardless — a third-party contract must never mint the account that administers the server, and provisioning is refused outright before any admin exists.

**Named residuals:** a credentials-kind provider receives the raw password (inherent to a bind verifier; bounded by `allowedDomains` and the per-provider allowlist); a malicious signed plugin bypasses all of this via raw SQL anyway (pre-existing — the signature gate owns malice, this contract defends against the honest-bug population); there is no live revocation, so an externally-deleted user keeps a session until TTL or admin disable (deliberate — the alternative reinserts plugins into the request path).

## Lyrics Providers

`defineLyricsProvider` + `runtime/lyrics-providers.ts`. Same acquisition shape as subtitles — the host already stores and serves lyrics, so a provider's job ends at handing them over.

Consulted BEFORE the builtin LRCLIB path in `resolveLyrics`, first non-empty answer wins: an operator who installed a provider wanted it consulted, and falling through keeps today's behaviour for tracks a plugin cannot help with. **Sequential, not concurrent** — first-answer-wins means a parallel fan-out would spend every provider's rate limit to discard all but one result.

Detection: `fetchLyrics` is checked before the metadata-provider branch. The persisted `source` is now the provider that actually answered rather than a hardcoded `'lrclib'` — with more than one source, "where did these lyrics come from" became a question a user can reasonably ask. The pre-fetch not-found marker (no artist/title to query with) records `source: null`, since nothing was consulted.

## Subtitle Providers

`defineSubtitleProvider` is an **acquisition** contract, not a serving one: `search()` returns candidates, `download()` returns bytes, and the host turns the chosen one into a sidecar beside the video plus an `external_subtitle_files` row. From then on `subtitle-resolver.service.ts` serves it by the ordinary external-subtitle path and never knows a plugin was involved — which is why nothing in the resolver changed.

- **Detection order matters.** A subtitle provider and a metadata provider both expose `search`, and the metadata branch matches on `search` ALONE. The subtitle branch (`search` + `download`) is therefore checked FIRST in `detectSdkDefinition`, or a subtitle provider silently registers as the wrong kind. `download` is also in `CONTRACT_METHOD_KEYS` so a settings-only export can't hide one.
- **Ranking** (`rankCandidates`): viewer language preference order, THEN exact hash match, then downloads, then rating. Language outranks a hash match deliberately — a perfectly-timed subtitle in a language the viewer can't read is worth less than a decent one they can.
- **Search is isolated per provider** (15s budget, throw/hang/non-array all yield an empty contribution); **install is not** — it is one deliberate user action on one provider, so it throws with a readable reason rather than silently doing nothing.
- **Third-party data reaches the filesystem.** A candidate's `language` lands in a filename, so `sidecarPathFor` enforces an ISO-639 shape (a separator or `..` would escape the directory), the video's own path is re-checked with `isPathWithinMediaStore`, the write uses `wx` (never clobber an unregistered sidecar), and a same-language collision gets a `.2` suffix rather than replacing the existing row (which is keyed on `subtitle_path`).
- `normalizeDownload` caps at 10 MB — pinned to the resolver's own read limit, since a larger file would write successfully and then never be servable.

## Host-side Contract Validation

The `defineX` helpers validate every rule the contracts declare, but a builtin got that for free (it calls them) and an external plugin never did — the SDK is types-only at runtime, so an external author's plain object reached the loader checked by nothing but duck-typing on a method name. `capabilities.browserUi` was the visible casualty: the flag that discloses "this plugin runs its own JS in your dashboard" was enforced _solely_ inside `defineFeature()`, i.e. solely for the population it was never written for.

`loader.ts` now runs the matching validator (`SDK_VALIDATORS`) over **every** detected contract, in phase 1, before anything registers. A failure is a per-plugin load error carrying the SDK's own message (`defineFeature(id): widgets require capabilities.browserUi: true`), so an operator gets a fixable line rather than "failed to load".

- **All nine validators are pure** (validate, return the input) **except `defineWatchSync`**, which returns a new object carrying synthesized `__autoTasks` stubs. The loader calls it for its checks and DISCARDS the result — what registers stays exactly what the plugin exported. Whether external watch-syncs should also gain those stubs (builtins do, via `builtin/index.ts`) is a separate behavioural question, not something to change silently while adding validation.
- **This is stricter than before** and will refuse plugins that used to load — a definition missing contract-required fields was previously registered anyway. That is the point, and now is the moment: there is no third-party ecosystem yet, so it costs nothing. All four in-repo plugins already pass.
- Loader test fixtures must therefore be COMPLETE definitions, not merely detectable shapes.

## Contract ABI Gate

`PLUGIN_SDK_ABI` (a constant in the SDK's `types.ts`) is the version of the plugin contract surface. Bump it ONLY when a change would break a plugin compiled against the previous number — a removed/renamed `PluginContext` / `TaskContext` surface, a changed `defineX` shape, a new required field on a definition.

A signed manifest declares `sdkAbi`. **Absent ⇒ 1** (it predates the field), so every manifest signed before this keeps installing on an ABI-1 host and correctly fails the moment the host moves past it. `scripts/plugin-sign.mjs` fills it from the plugin's `plugin.json` or, by default, from the SDK sources in this checkout — the signer and the SDK ship together, so its own version is the right default.

Enforced at **two** points, and both matter:

- **Install** (`runPreamble`): a mismatch is a 400 naming both numbers. Deliberately NOT forceable — `force` exists to re-install or roll back a version, not to admit code built against contracts this host no longer has.
- **Load** (`loadOneDir`, every path — boot / reload / enable / install): re-checked against `external_plugins.sdk_abi`. This is the case the persisted column exists for: the plugin was admitted by whatever host version installed it, which is not necessarily this one. Without it, a host upgrade would silently re-import a stale plugin and the operator's first symptom would be a `TypeError` from inside third-party code. A NULL predates the column (migration `16.229.0`) and reads as ABI 1. Refusal is a per-plugin load error; the rest of the boot batch still loads.

`ExternalPluginUpsert.sdkAbi` is optional and omission fails **closed** — no value writes NULL, NULL reads as ABI 1, and on any host past ABI 1 that plugin then refuses to load rather than being silently admitted.

**Still unenforced:** `TaskDefinition.minAppVersion` is a required SDK field that nothing compares against. It is a distinct axis from the ABI (app version vs contract surface) and the ABI covers the actual breakage class; the field should either grow a check or be dropped to advisory.

## Integration Events + Webhook Ingress

`IntegrationDefinition`'s two contract methods are live (both shipped declared-but-never-called).

**Outbound — `sendNotification`.** An integration declares `subscribes: ['org.lumastra.task.run.failed', ...]` (or `['*']`) and receives those host events. Delivery is **opt-in** (no `subscribes` ⇒ nothing, so the eight builtins with no-op `sendNotification` are unaffected), **in-process, at-most-once**, time-boxed at 10s per handler, and fully isolated — a handler that throws or hangs can neither stop its peers nor fail the task run / scan that emitted the event. There is no durable queue and no cross-replica fan-out; that is the operator webhook outbox's job, not this one's. Published from two taps: `WebhookOutbox.enqueue` (all `task.run.*` + `cost.threshold.exceeded`, before and independent of the hook lookup, so plugins get events on installs with zero operator webhooks) and `handleMediaBecamePlayable` (`media.item.added`, one event per item rather than the operator path's per-hook batches). The outbox imports the publisher LAZILY — a low-level delivery worker must not drag the registry + plugin-context graph into everything that imports it.

**Inbound — `handleWebhook`.** `POST /api/plugin-webhooks/<integrationId>` reaches an integration's `handleWebhook`. Two gates must BOTH be open: the author declares `capabilities.webhook: true`, and an operator sets that integration's `webhookSecret` secret. Either missing ⇒ **404, never 401** — an unauthenticated caller must not be able to enumerate which integrations exist or which merely await configuration. The secret is presented as `X-Plugin-Webhook-Secret` and compared constant-time (both sides hashed first, so length is not a fast path). Handler errors answer a generic 500; the message is logged, never returned. The route sits at its own top-level path rather than under `/api/plugins/*`, where any static segment would shadow a feature plugin whose id matched it. It is exempt from forward-auth (callers hold no session) and from the CSRF origin check (same criterion as `/j`, `/subsonic`, `/oauth`: cookie-blind and self-authenticating — and real senders post form-encoded bodies the check would otherwise 403). Both exemptions are scoped to the prefix **with** its trailing slash and pinned by tests against lookalike siblings.

## Remote Signed Install (Variant C)

Operators can install external plugins remotely via `POST /api/v1/plugins/external/install` (manifest URL + detached Ed25519 signature). The host fetches the manifest + bundle under SSRF/size/timeout guards, verifies the signature against ENV-configured trusted keys, persists to the `external_plugins` registry, and hot-loads (fresh install) or stages-for-restart (upgrade). Lifecycle: `enable` / `disable` / `reload` / `uninstall`.

6. **Signature == full host trust.** An external plugin's top-level import code runs **UNRESTRICTED** in the host Node process before any capability is inspected. Declared `capabilities` are cooperative metadata, **not a sandbox**. A valid signature therefore grants full host trust — treat signing keys like production deploy credentials.
7. **`PLUGIN_TRUSTED_KEYS` is ENV-ONLY** (`keyId:base64Spki` list, Ed25519 only). It is read straight from `process.env`, **never** from ConfigService / `settings.json` — the settings store is admin-UI-writable, so sourcing trusted keys from it would let a settings write collapse the entire trust gate. Same for the gate flags below.
8. **Gate flags (all env-only):**
    - `PLUGINS_EXTERNAL_INSTALL_ENABLED` — **default-ON** (set `=false` to hard-disable). This only makes the endpoint _available_; install additionally requires a non-empty **effective** trusted set — `buildEffectiveTrustedKeys()`, i.e. official anchor ∪ operator env (400 "no trusted signing keys configured" otherwise). Since the anchor now ships `lumastra-official-2026`, that condition is satisfied out of the box: an operator who configures nothing can install **officially-signed** plugins, and still needs `PLUGIN_TRUSTED_KEYS` for anyone else's. Before the anchor was populated this read "hard-requires `PLUGIN_TRUSTED_KEYS`", which is no longer true.
    - `PLUGIN_INSTALL_ALLOW_PRIVATE` — allow fetching manifests/bundles from private IPs (dev only); default off pins fetches to the resolved public IP to defeat DNS-rebind.
    - `PLUGINS_REQUIRE_REGISTRY` — strict mode: on-disk plugin dirs are loaded only if a matching `installed`+`enabled` registry row exists (rejects unmanaged drop-ins). **Default OFF** — see point 13 for what the registry does and does not gate.
9. **Multi-contract plugins.** A default export may be a `PluginDefinition` aggregate (`{ tasks: [], watchSyncs: [], … }` — what `definePlugin` returns) instead of a single def, so one signed install can register several contracts. The manifest declares them in a signed **`kinds`** array (mutually exclusive with `kind`; the loader compares declared-vs-loaded as a SET). Two rules the loader enforces on every aggregate, registry-managed or drop-in:
    - **Namespace** — every contract id must be `<plugin>` or start with `<plugin>-`, so a bundle can never register an id inside another plugin's namespace.
    - **Anchor** — exactly one contract must claim `<plugin>` itself. The host answers "is this plugin loaded?" with `hasPluginRegistered(<dir name>)` (used for fresh-vs-upgrade classification at install, the reload skip check, and the admin card's state+kind badge); an anchorless bundle would read as unloaded to all of them and be re-imported into a duplicate registration.

    Validation is **two-phase**: every element is checked (id shape, namespace, anchor, intra-bundle duplicates, cross-plugin collisions, worker isolation) BEFORE any element registers — there is no unload, so a bundle rejected halfway would strand live contracts. The residual case is a registry-internal throw mid-registration (e.g. a duplicate `coversStages` claim); the load is reported failed and the installer rolls files+row back, but earlier elements stay registered until restart — the same exposure the single-contract path already has.

10. **`isolation:'worker'` is unsupported for external tasks.** The worker sandbox loads builtins only, so a worker-isolated external task would fail to resolve its own bundle at run time. Install rejects any external task def declaring `isolation:'worker'` **pre-registration** — the id/kind/isolation check runs in `loader.ts` BEFORE `registerSdkDefinition` (and before any per-task worker starts), so a rejected bundle never registers a def or starts a worker (there is no runtime unload to undo either). The installer threads the manifest's expected name + kind + a reject-worker flag into the load for a fresh install; `loadOneDir` ALSO sets `rejectWorkerIsolation: true` for every registry-managed load (merged under any caller constraints), and that check sits OUTSIDE the `expectedName` identity block, so the isolation rule runs on **every** load path a registry-managed plugin can take — boot, hot-reload, and `enable` — not only a fresh install (security review 2026-09-12, C18). The identity/kind half stays installer-only: it needs the SIGNED manifest, and a registry row's `name` is the install directory, which a legacy single-contract plugin's def id need not equal.
11. **Restart semantics.** Signature grants trust at load time, but there is no per-plugin runtime sandbox and no safe unload — `disable`, `uninstall`, and `downgrade` take effect only on the **next process restart** (handlers honestly return `restartRequired: true`). Removing a trusted key does **not** unload already-installed plugins. Every load path re-verifies the on-disk `index.js` sha256 against the registry checksum.
12. **Bundled and installed plugins live in SEPARATE directories** (since 2026-08-27). `$PLUGINS_BUNDLED_DIR` (default `/app/plugins-bundled`) is what the image ships, read-only and always current with the image. `$PLUGINS_EXTERNAL_DIR` (default `/app/plugins`) is where installs land and is the one that needs a volume. Discovery scans bundled FIRST and it wins a name collision, because an operator's volume can hold a frozen first-use copy of a bundled plugin that would otherwise shadow the shipped one forever; the ignored directory is logged rather than passed over in silence.

    They shared one path until then, and that single decision broke both halves at once: a named volume mounted for persistence is seeded from the image only on FIRST use and never re-seeded, so a first-party plugin fixed in a later image never reached an existing deployment — and strict mode disabled every bundled plugin. Neither is fixable while the directories are one.

13. **`PLUGINS_EXTERNAL_DIR` must be a persistent, shared, writable volume.** Two separate reasons, and the first bites a SINGLE-replica install too:
    - **Persistence.** The default is `/app/plugins`, which lives in the container IMAGE layer. With no volume mounted there, every installed plugin is destroyed by the next image update while its row survives in Postgres. A routine `--force-recreate` removes the plugin directories while their registry rows stay. `docker-compose.example.yml` mounts a named volume for exactly this; a deployment that does not is one image pull away from losing every plugin. The admin list now names the missing directory rather than rendering the loss as an ordinary pending-restart (`missingDirError`), and a same-version re-install is permitted as a REPAIR.
    - **Sharing.** The registry is shared Postgres but each replica imports from its own filesystem, so without a shared volume every replica must be re-installed or rolling-restarted.

    **What a shared volume does and does not fix** (several replicas on one named volume): installing on one replica puts the FILES on all of them immediately — but the other replicas report `loaded: false, restartRequired: true`, because loading is an in-process `import()` that only the replica handling the request performs. Files are shared; **code loading is not**. So a shared volume removes the re-install step, not the rolling restart.

14. **What the registry gates (and what it does not).** The `external_plugins` registry gates **INSTALLED (remotely-fetched) plugins**: every load path re-verifies a managed dir's on-disk `index.js` sha256 against the row checksum, loads only `index.js` (ignoring `package.json#main`), and skips `disabled`/`uninstalled` rows. It does **NOT**, by default, gate **registry-less drop-in dirs** — with `PLUGINS_REQUIRE_REGISTRY=false` (the default) a hand-placed dir under `PLUGINS_EXTERNAL_DIR` still loads unverified at boot. That is the original admin-vetted drop-in model: placing such a dir requires filesystem write access to `PLUGINS_EXTERNAL_DIR`, which is itself a high trust bar (equivalent to editing the deploy). Operators who enable remote install and want _only_ signed, registry-managed plugins to load should set **`PLUGINS_REQUIRE_REGISTRY=true`** (recommended when install is enabled) — this makes registry-less drop-ins non-loadable while leaving installed plugins working. The default stays OFF so existing drop-in deployments are not broken by an upgrade.

**That recommendation was unusable until 2026-08-27.** Bundled first-party plugins have no registry row either, so strict mode silently disabled all four of them — the one setting that closes the unverified-drop-in hole broke the shipped feature set. They now live in a SEPARATE directory (`$PLUGINS_BUNDLED_DIR`, default `/app/plugins-bundled`) and are exempt: shipping inside the verified image is a stronger provenance guarantee than a database row. The exemption is scoped to that directory alone — a hand-placed drop-in under `$PLUGINS_EXTERNAL_DIR` is still refused in strict mode, and a test pins that distinction. 15. **Manifest fetch precedes signature verification (accepted residual).** To verify a signature _over_ the manifest bytes the host must first fetch them, so `manifestUrl` (and later `bundleUrl`) is fetched **before** the signature is checked. For an admin-scoped caller this is a mild SSRF / port-scan timing oracle against **public** hosts (a fetch of an attacker-chosen URL whose success/latency the admin can observe). It is inherent to signature-over-bytes and is mitigated by: (a) the endpoint being **admin-scoped**, and (b) the default public-IP restriction (`PLUGIN_INSTALL_ALLOW_PRIVATE=false` pins fetches to the resolved public IP, blocking private/link-local targets and DNS-rebind). No code fix — documented as accepted.

### In-repo Official-Key Trust Anchor + Hybrid Resolution

The trusted-key set used at install-verify time is `official anchor ∪ operator env`, resolved entirely in `external-install/trust-anchors.ts`. Both halves now ship: the mechanism, and a populated anchor (`lumastra-official-2026`). What is still outstanding is the _signing pipeline_ — the key is held offline by hand rather than by an HSM/CI signer, so nothing published should be signed with it until that exists.

- **(a) Baked official anchor.** `OFFICIAL_TRUSTED_KEY_ENTRIES` in `external-install/trust-anchors.ts` is a **compile-time code constant** (`keyId:base64Spki` entries, Ed25519 only), NOT read from ConfigService / `settings.json`, NOT fetched at runtime, NOT editable via any web surface. It travels with the verified application code, so a website/CDN compromise cannot swap it — changing it requires a source commit + release. It **ships `lumastra-official-2026`** as of the 2026 release; the public half is mirrored at `https://lumastra.org/.well-known/lumastra-signing-keys.json` for out-of-band verification, and the private half is not in the repository. An empty anchor would mean zero official trust, i.e. behavior byte-for-byte identical to the operator-only model; a populated one means anything it verifies runs with FULL HOST TRUST on every install, with no revocation (removal blocks future installs but unloads nothing), so the private key is a release-signing secret. `trust-anchors.test.ts` pins that the anchor is non-empty, is public Ed25519 material only, and never carries a test/fixture key. As with the gate flags (point 7), trusted keys are code/ENV, never settings.
- **(b) Hybrid resolution (official-wins).** `buildEffectiveTrustedKeys(officialEntries?, operatorRaw?)` parses the anchor first (tagged `source:'official'`) then the operator env `PLUGIN_TRUSTED_KEYS` (tagged `source:'operator'`, default `process.env.PLUGIN_TRUSTED_KEYS` — ENV-only). Official keys are tried first and **win** official-vs-operator keyId collisions: an operator entry reusing an _official_ keyId is DROPPED with a WARN so it can never shadow/impersonate an official keyId in audit output. **Intra-operator duplicate keyIds are PRESERVED** — the collision set is official keyIds only, so the classic `rot:OLD,rot:NEW` mid-rotation layout keeps verifying against both materials exactly as `parseTrustedKeys` + verify-every-key do today.
- **(c) Key-id reporting.** `verifyManifestSignature` returns `{ keyId, source }` — always the trusted key that _cryptographically matched_, never the advisory `manifest.keyId` (which selects nothing; a mismatch is logged non-fatally). The verifying keyId is persisted on `external_plugins.signing_key_id` (migration `16.169.0`, nullable — NULL = legacy/pre-migration or registry-less drop-in). The live `signingKeySource` (`official`/`operator`/`unknown`) is **DERIVED at read time** via `classifyKeyId(keyId, effective)` — never persisted, since a snapshot goes stale after rotation — and surfaced on the admin/API DTOs (the GET-list handler builds the effective set **once per request**).
- **(d) Removal ≠ unload (rotation is reporting, not revocation).** Removing a trusted key (env or anchor) blocks _future_ (re)installs signed by it but has **zero effect on already-installed plugins**: the load gate (`loadOneDir`) re-verifies checksum/tree-digest against the registry row and **never** consults the trusted-key set. A plugin installed under a since-removed key stays loaded across restarts and its `signingKeySource` simply reports `unknown`. Cryptographic revocation / signature re-verification at load time is explicitly out of scope (invariant #3 keeps restart-only, removal-does-not-unload semantics).

### Multi-file Signed Bundles

A plugin may ship as a **multi-file signed `tar[.gz]` bundle** (declared entry + assets) instead of only a single self-contained `index.js`. Bundle-vs-single is chosen by an **explicit signed manifest field**, never guessed.

- **Signed manifest fields.** `format: 'bundle'` + `entry: '<relative posix path>'` are part of the **signed** manifest bytes (Ed25519 over the raw bytes, unchanged). For a bundle, `checksum` binds the **archive bytes** (`sha256(archive)`), verified at install exactly as the single-file checksum is. Compression (`tar` vs `tar.gz`) is detected from the archive's gzip magic bytes and does not change the signed identity. Absent `format` ⇒ `'single'` (existing plugins keep working byte-for-byte; their `bundle` column stays `NULL`).
- **Self-contained ustar reader** (`external-install/archive.ts`, no `tar` npm dep). Extraction rejects, on the **first** offending entry and **before any write**: `..`/absolute/`.`/empty path segments, backslash/win-drive, all C0 control bytes + DEL in any path, any non-regular typeflag (directory `'5'`, symlink `'2'`, hardlink `'1'`, device `'3'/'4'`, fifo `'6'`, contiguous `'7'`, pax `'x'/'g'`, GNU `'L'/'K'`), base-256/non-octal numeric fields, duplicate/case-fold-colliding paths, a declared size exceeding the remaining archive bytes, and a missing two-zero-block end marker. Directories are materialised implicitly via `mkdir`-parents (explicit dir entries are rejected). Files are written `0o644`.
- **Non-secret caps (resource limits only — NOT the trust gate).** `PLUGIN_INSTALL_MAX_EXTRACTED_BYTES` (32 MiB total uncompressed), `PLUGIN_INSTALL_MAX_ENTRIES` (2048), `PLUGIN_INSTALL_MAX_FILE_BYTES` (8 MiB single file). These are ENV/ConfigService knobs (same tier as the existing byte/timeout caps); they can only bound size/count, never grant trust. The trust-gate flags (`PLUGIN_TRUSTED_KEYS`, `PLUGINS_EXTERNAL_INSTALL_ENABLED`, `PLUGIN_INSTALL_ALLOW_PRIVATE`, `PLUGINS_REQUIRE_REGISTRY`) stay ENV-only. The gzip transfer is bounded early by `zlib maxOutputLength`; the uncompressed size is bounded independently by the caps (defence-in-depth against a small-on-the-wire bomb).
- **Whole-tree re-verify on every load path.** Install extracts into a private `.tmp-<rand>` dir → atomic-rename (a partial tree is never live), derives a canonical **order-independent `treeDigest`** over the extracted files + per-file digests, and persists them to the trusted `external_plugins.bundle jsonb` column. Every load path (`loadOneDir` at boot / reload / enable / install) re-walks the on-disk tree with `lstat` (never follows links, refuses any non-regular entry on sight, stays within-root, bounded by the caps) and recomputes the digest from the DB listing — any add/remove/modify of **any** file refuses the load. This extends the single-file `sha256(index.js) === row.checksum` guarantee to the whole tree. A corrupt/hand-edited `bundle` jsonb parses fail-closed (`safeParse` → invalid-bundle sentinel → that one plugin refuses to load; the rest of the boot batch still loads).
- **Read-only-dir invariant (author footgun).** A managed bundle's install dir must stay **read-only to the plugin at runtime** — any file the plugin (or anything else) writes into its own dir mutates the on-disk tree and fails the _next_ boot's tree-digest re-verify. This is the desired fail-closed tamper detection, but plugins MUST write state elsewhere (`ctx.secrets`, DB), **never** into their install dir.
- **Bundles must ship ESM** (`"type":"module"` or a `.mjs` entry). The loader ignores a bundled `package.json#main` (entry comes from the signed manifest), but Node still honours a bundled `package.json#type` when resolving the entry — a `"type":"commonjs"` flips import semantics for the whole tree and fails **closed** as a per-plugin load error (never a host crash). The signer warns on such a `package.json`.
- **Same trust posture.** A signed bundle still gets **full host trust** (no sandbox); `disable`/`uninstall`/`downgrade` are restart-only (no runtime unload); `isolation:'worker'` is rejected pre-registration for a bundle entry exactly as for single-file. Sign with `scripts/plugin-sign.mjs --format bundle [--entry index.js] [--gzip]` (canonical deterministic ustar → reproducible archive checksum).

## Hot-load (Variant A)

The admin Extensions page exposes a "Reload plugins" button that triggers `POST /api/admin/plugins/reload` → `reloadExternalPlugins()` in `runtime/loader.ts`.

- **Hot-load only.** This adds NEW plugins dropped into `$PLUGINS_EXTERNAL_DIR` since boot. Modifying or removing an existing plugin still requires a process restart — replace/unload semantics are not supported (cached references in scheduler/runner/field-authority resolver can't be invalidated safely).
- **Multi-replica:** only the replica that handles the request LOADS the new plugin. With a shared `PLUGINS_EXTERNAL_DIR` volume the files are visible to every replica at once, but visibility is not registration — the others still show `loaded: false` until they reload or restart. Trigger the reload per replica, or rely on a rolling restart.
- **Scheduled tasks** registered by hot-loaded plugins fire within `~10s` (the scheduler tick interval). `runOnStartup: true` is honoured only at boot — it does NOT re-fire on reload; the steady tick picks the task up at its next bucket.

## Admin Extensions UI (list + install + lifecycle)

The admin Extensions page (`/admin/settings/plugins`) LISTS installed external plugins by joining the `external_plugins` registry against live loader state (`listExternalPluginsWithState` in `services/external-plugin-manager.service.ts`) and supports remote install + `enable`/`disable`/`reload`/`uninstall` via the internal admin BFF at `/api/admin/plugins/external/*` — a **cookie-auth twin** of the v1 `tasks:admin` endpoints (same manager, same installer/loader; NO new capability or trust path). The card surfaces the verifying `signingKeyId` + its derived `signingKeySource` (official/operator/unknown) + declared `capabilities` **read-only**, and honestly shows `restartRequired` (list-truth, never a mutation literal) — `disable`/`uninstall` pair with "takes effect on restart" while the plugin is still `loaded`.

- **Trusted keys / gate flags stay ENV-only.** The UI exposes booleans only (`installEnabled`, `trustedKeysConfigured`, `requireRegistry`) — never key material and no write path to the trust set.
- **Per-replica:** install/lifecycle takes EFFECT on the replica that served the request, exactly like "Reload plugins". On a shared plugins volume the installed files land everywhere immediately — which is easy to misread as "it worked on all replicas". It did not: a replica that did not serve the install reports `loaded: false, restartRequired: true` while listing the plugin, because the registry row it reads from is shared Postgres. The card is honest about this; the file listing is not evidence.
- A just-`uninstalled` row that is still `loaded` renders as a persistent "uninstalled — still loaded, restart required" card (uninstall is restart-only); once its code is actually gone (no longer `loaded`) it drops out of the list. The read join uses `listExternalPluginsIncludingPendingRemoval` so such a row is not lost the instant it is marked uninstalled.
