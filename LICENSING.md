# Licensing

Lumastra is **open core**. This document is the authoritative map of what is licensed how.
In case of any ambiguity, the rules in this document govern; per-file `SPDX-License-Identifier`
headers are declaratory (they restate the rule, they do not override it).

> Principal copyright holder and licensor: **Denis Arnst (Sapd)**. This identifier is used consistently across
> `LICENSE`, the per-file SPDX headers, and any commercial agreement.

---

## 1. The open-source license (default)

All source in this repository is licensed under the **GNU Affero General Public License v3.0
only** (`AGPL-3.0-only`) — **except** (a) the files under the **§3.1 Proprietary** paths, governed
solely by `LicenseRef-Lumastra-Proprietary`; (b) the files under the **§3.2 Enterprise** paths,
governed solely by `LicenseRef-Lumastra-Enterprise`; and (c) the brand-asset paths listed in §6,
which are `LicenseRef-Lumastra-Branding` (all rights reserved). The full AGPL text is in
[`LICENSE`](./LICENSE) (and, for SPDX/REUSE tooling,
[`LICENSES/AGPL-3.0-only.txt`](./LICENSES/AGPL-3.0-only.txt)).

The split is **path-based**, not header-based: a file under a §3.1 path is Proprietary-licensed, a
file under a §3.2 path is Enterprise-licensed, a file under a §6 branding path is an
all-rights-reserved brand asset, and every other file is AGPL — regardless of whether an individual
header is present or wrong. Headers merely restate this. It is enforced in CI
(`scripts/check-license-boundary.mjs`), which fails if a protected file lacks **its tier's** SPDX tag
(Proprietary or Enterprise) or a file outside the §3/§6 paths carries one. Non-code assets that
cannot carry a header (images, fonts) are
covered by the same path rule.

`-only` (not `-or-later`) is deliberate: it prevents recipients from opting into future AGPL
versions whose terms have not been reviewed.

## 2. Commercial license also available (dual licensing)

The same code is **also available under a separate commercial license** that does not carry the
AGPL's copyleft or source-disclosure obligations (including AGPL §13's network-use provision), for
organizations that cannot or do not wish to comply with the AGPL.

This is possible because the project retains **single licensing authority**: contributions are
accepted only under a [Contributor License Agreement (CLA)](./.github/CLA.md) that grants the rights needed
to relicense them, including under the commercial license. The inbound rights that make this
possible are secured by the [CLA](./.github/CLA.md); the source-available proprietary terms are in
[`LICENSES/LicenseRef-Lumastra-Proprietary.txt`](./LICENSES/LicenseRef-Lumastra-Proprietary.txt);
the commercial license itself is a negotiated grant, agreed individually.

**For a commercial license, contact:** <git@sapd.eu>.

> Note: AGPL and the commercial license are the same code under two sets of terms. The
> commercial license is a negotiated grant — it is **not** something a recipient may simply
> "choose" for free. That is why the per-file headers carry only `AGPL-3.0-only`; the
> commercial option is offered here, not encoded as an SPDX `OR` choice.

## 3. Protected components (NOT AGPL)

Two tiers of the codebase are **not licensed under the AGPL** — what you may do with them is
defined **only** by their respective licenses, not by their presence in any repository. They
differ in how they are distributed:

- **§3.1 Proprietary** (`/j` + the AI assistant) is **source-available**: it ships in the public
  open-core repository for transparency, contribution, and self-building, and is license-gated at
  runtime.
- **§3.2 Enterprise** (LMS / compliance reporting / product showcase) is **private and
  commercial**: it is **not part of the public open-core distribution**. Its source is provided
  only to licensees under a negotiated agreement (it lives in the internal repository and in
  licensee/commercial builds).

Each protected file carries the SPDX header for its tier. In SvelteKit a route's folder path _is_
its URL, so the URL-bound route entrypoints can't sit in one folder; each tier clusters its routes
into SvelteKit route **groups** (`(proprietary)` / `(enterprise)`) invisible to the URL. A single
marker — the segment `(proprietary)` or `(enterprise)` — identifies every file in a tier, alongside
its lib tree. The AGPL + Proprietary tree builds cleanly with **no** Enterprise files present.

### 3.1 Proprietary tier — `LicenseRef-Lumastra-Proprietary`

The Jellyfin-compatible client surface (`/j`, freemium / license-gated) and the AI assistant. Terms:
[`LICENSES/LicenseRef-Lumastra-Proprietary.txt`](./LICENSES/LicenseRef-Lumastra-Proprietary.txt).

| Path                                                             | What                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/server/proprietary/`                                    | Server-only — Jellyfin-compat serializers/handlers backing `/j`, the AI assistant tool-calling subsystem, and the runtime license-enforcement infra (`licensing/`) |
| `src/lib/proprietary/`                                           | Client-side AI assistant components                                                                                                                                |
| `src/routes/(proprietary)/`                                      | `/j` (Jellyfin-compat client API), `/assistant` (AI assistant page)                                                                                                |
| `src/routes/api/(proprietary)/`                                  | `/api/jellyfin-connect`, `/api/assistant`                                                                                                                          |
| `src/lib/server/api/defs/integrations/jellyfin-quick-connect.ts` | Quick Connect endpoint def, co-located in the shared defs tree (part of the `/j` surface)                                                                          |

### 3.2 Enterprise tier — `LicenseRef-Lumastra-Enterprise` (not in this repository)

A separate commercial tier — the LMS (courses, quizzes, trainings), compliance reporting, and
the product showcase — exists for organisations and is **not part of this repository or of the
open-core distribution**. Its source is provided only to licensees under a negotiated
agreement; contact <git@sapd.eu>. Nothing in this tree depends on it: the AGPL core and the
Proprietary tier build and run without it, and the license-boundary check enforces that no
file here imports it.

> **Layering — AGPL ◁ proprietary ◁ enterprise.** AGPL core imports neither protected tier;
> proprietary may import AGPL but not enterprise; enterprise may import AGPL + proprietary (it gates
> itself via the proprietary `licensing/module-gate`). `check-license-boundary.mjs` enforces this.
>
> The Proprietary components stay **in this repository** (the Authentik `enterprise/`-directory
> model): source-available, clearly marked, and **license-gated at runtime** rather than
> extracted to a separate repo. The paths in the §3.1 table are the complete set of non-AGPL
> components in this tree; everything else in the repository is AGPL. Enterprise files exist
> only in licensee builds.
>
> **Redistribution & packaging:** the AGPL rights cover only the AGPL subset. The protected files —
> Proprietary (`LicenseRef-Lumastra-Proprietary` §2(d)) and, where present in a licensee build,
> Enterprise (`LicenseRef-Lumastra-Enterprise` §3(b)) — may be redistributed **verbatim**, either as part of an
> Official Distribution **or** as part of a third-party package or image of Lumastra (e.g. a community
> container image like `linuxserver/lumastra`, or a distro package), so long as they stay unmodified
> and the license gate is intact — or removed entirely to ship an AGPL-only tree. That grant is for
> DISTRIBUTION only: actually **using** the Enterprise modules in production still requires a
> negotiated commercial Enterprise Agreement (the modules are runtime-gated and inert without a key).
> Naming of such packages is governed by §6.

### 3a. What stays AGPL, and the one-directional invariant

The AI **assistant** is proprietary only at its _tool-calling + chat_ layer. Its underlying
data/query layer is **AGPL** and is shared with the open recommendation features, so it lives in
AGPL core — the core query barrel `src/lib/server/database/queries/index.ts` re-exports it, and
AGPL core never imports the proprietary tree. Specifically:

- **AGPL (shared with open features):** `src/lib/server/database/queries/assistant-rag.queries.ts`,
  `…/assistant.queries.ts`, and all of `src/lib/server/ai/` (embeddings, vector search,
  recommendations — For-You, similar-items, mood, music quick-picks).
- **AGPL (open):** `src/lib/server/subsonic-compat/` (Subsonic API); core streaming/HLS; hardware
  transcode; watch-sync connectors incl. MyAnimeList (`plugins/mal-watch-sync/`); live TV; personal
  stats; watch-together; requests.
- **Proprietary:** only the paths listed in the §3 table.

**Invariant (enforced):** AGPL core must never statically import the proprietary tree (the reverse
is fine; cross-boundary calls from core go via the entitlements registry or HTTP). Checked by
`scripts/check-license-boundary.mjs` (run in `npm run lint`). The optional-load shim in
`src/lib/server/licensing/entitlements.ts` (`import.meta.glob`) is the sanctioned exception.

### 3b. What the license check sends, and where

License **verification is fully offline.** Keys are signed off-box and checked locally against the
baked-in ECDSA P-384 public key in `src/lib/server/proprietary/licensing/public-key.ts` (issuer
`lumastra`, algorithm `ES384`; the SHA-256 SPKI fingerprint is published in that file so you can
confirm the keypair). A valid key keeps working on a machine with no internet at all — nothing is
phoned home to decide whether you are licensed.

The one outbound call is **key issuance/renewal** (plus a weekly check-in), under these conditions:

|               |                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint**  | `POST https://lumastra.org/api/license/refresh` (10s timeout); `/api/license/issue` while no key is stored                                                      |
| **When**      | When the stored key is missing, invalid, expired, or expiring soon; when push needs its relay token (below); and otherwise about once a week (check-in, below). |
| **How often** | A check ~5s after boot, then every 6h; each check calls out only when one of the above applies                                                                  |
| **Sent**      | Three fields at most — nothing else (see below)                                                                                                                 |
| **Received**  | A signed license key, stored as `LICENSE_KEY` in `settings.json`, and a push relay token (memory only)                                                          |

The request body is `{ install_uuid, rc, app_version }` (`rc` is left out on the enforcement-off
relay-token call):

- **`install_uuid`** — a random per-deployment UUID (`gen_random_uuid()`, one-row `license_install`
  table; see its DDL in `src/lib/server/database/base-schema-sql.ts`). It is deployment identity
  only: not derived from hardware, network, account, or library data. You can read it yourself at
  **/admin/system/instance**.
- **`rc`** — one small integer describing licensing state. Only four values can ever be sent: `0`
  healthy, `1` free tier (no valid key — expected and benign), `2` renewing or within grace, `7`
  local state did not match an honest free tier. (A fifth code, `8`, exists but is **local-log
  only** — it is produced solely on the enforcement-off path, whose only network call, the push
  relay-token renewal, sends no `rc` at all.)
- **`app_version`** — the build's version string (`APP_VERSION`, e.g. `v0.1.3`). The licensing
  server keeps only the release number for its install counts.

**Weekly check-in.** A valid key that makes no other call still calls `/refresh` about once a week
(7 days ±10 %, `license-check-in.ts`), so the licensing server can count running installs. The time
of the last successful call is shared through Valkey, so restarts and replicas do not add calls, and
a server process never checks in during its first hour (a crash loop cannot call out on every boot).
A failed check-in is logged and tried again a day later; it never changes the key or the
entitlements. For a valid key, a returned key (from the check-in or the relay-token call) is stored
only when it verifies for this install and changes nothing but a later expiry — same tier, same
entitlements (the early-access end date was moved). Any other key waits for the regular renewal. No
check-in on a build with enforcement off, or when the admin turned off **Weekly licence check-in**
(`LICENSE_CHECK_IN_ENABLED`, Admin → Settings → General → Licensing, also offered in `/setup`);
that switch never stops a renewal or the relay-token call. With the check-in off, a moved early-access
end date reaches the install only in the 14-day renewal window (or through a relay-token call).

**Switching off all contact.** **Contact lumastra.org for the licence**
(`LICENSE_SERVER_CONTACT_ENABLED`, Admin → Settings → General → Licensing, also offered in
`/setup`) stops every call above: no issue, renewal, check-in or relay-token call
(`license-refresh.ts` returns before any request, and the one function that sends it refuses on
its own). It applies without a restart. With it off, an install with no key runs on the free tier
at once, with no no-key grace window, so it is never downgraded later by surprise. A stored key
that verifies keeps its entitlements until its `exp`, is never renewed, and gets no 14-day grace
after it (that grace only covers a server outage at renewal time). A key obtained by hand at
lumastra.org/license and pasted in still works, since verification is offline. Switching it off
also drops the held push relay token, so push through the standard relay stops at once. The first
tick runs within half a minute of the first start, before the setup wizard, so only the
environment variable set before that start avoids the first enrolment. Switching it back on runs a
tick within half a minute and turns **Weekly licence check-in** back on (its default).

**What the licensing server records.** For its install counts, per successful call: the endpoint,
the tier issued, the release number, the country Cloudflare derives from the connection, and a
pseudonymised install ID — a keyed hash (HMAC-SHA256 with a server-side secret) of `install_uuid`
instead of the UUID. No IP address, no licence key. Kept for three months (how many installs, which
versions). The connection itself goes through Cloudflare like any request to lumastra.org, and its
short-lived request logs can contain the IP address.

**Nothing else leaves the machine.** No titles, file paths, library contents, watch history, user
accounts, or assistant prompts — the licensing loop never reads them.

**Push relay token.** The same response carries a short-lived (≤24h) credential for the push relay
at `push.lumastra.org`, bound to the `install_uuid` and signed with a key separate from the license
key. While `FEATURE_PUSH_NOTIFICATIONS` is on (the default), the relay is the delivery route (no
`APNS_KEY_P8` of your own) and no `PUSH_RELAY_TOKEN` is configured, the loop makes this call on every
6-hour tick to renew that token — even when the license is valid (the returned key is then
stored only if it just moves the expiry later, see the weekly check-in) and even on a build with
enforcement off (that call sends `install_uuid` and `app_version`, no `rc`, and never stores a key).
Each server process holds its own token, so a split web/worker deployment makes one
call per process. Turn push off, use your own Apple key, or set `PUSH_RELAY_TOKEN` for your own
relay, and this renewal never happens.

Enforcement is the build-time constant `LICENSE_ENFORCEMENT_BUILD_DEFAULT` in
`src/lib/server/config.ts`, **on** in official builds since the open-source launch. An **AGPL-only
self-build** (proprietary tree deleted) has no licensing loop at all — and therefore no relay
token; push then needs your own relay (`PUSH_RELAY_URL` + `PUSH_RELAY_TOKEN`) or your own Apple key.

The server URL is a hardcoded constant in
`src/lib/server/proprietary/licensing/license-server.ts` — deliberately **not** an admin setting or
a production env var, because a different server cannot issue a key that verifies against the
baked-in public key above. (An env override is honoured only on a dev build.)

**If you would rather it never ran:** block egress to `lumastra.org`. The loop is fail-safe — every
error is swallowed and the existing key is left in place — so the consequences are that the key
eventually expires and the deployment falls back to the free tier, and that push through the
default relay stops within a day (capabilities then report it unavailable). It never blocks login, browsing,
or free-tier playback. Each check also writes one local `license status refreshed` log line.

### 3c. Network endpoints

"Nothing else leaves the machine" above is a statement about the **licensing loop**, not about
the product: features you enable (metadata providers, AI, push) make their own outbound calls,
inventoried at <https://lumastra.org/reference/data-flows/>. Three endpoints are operated by the
maintainer:

| Endpoint                                                      | Contacted?                                                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://lumastra.org/api/license/refresh`                    | As described in §3b — license renewal, about weekly as a check-in, and every 6h while push uses the default relay (`/issue` for the first key).  |
| `https://push.lumastra.org`                                   | Only when `FEATURE_PUSH_NOTIFICATIONS` is on and `PUSH_RELAY_URL` is left at its default; receives device push tokens and a content-free banner. |
| `https://lumastra.org/.well-known/lumastra-signing-keys.json` | **Never.** A published mirror of the plugin-signing public key baked into `src/lib/server/plugins/external-install/trust-anchors.ts`.            |

## 4. Plugin SDK and sample plugin license

The `packages/@sapd/lumastra-plugin-sdk*` packages and the sample plugins under
`examples/plugins/` are licensed **`Apache-2.0`** (full text in
[`LICENSES/Apache-2.0.txt`](./LICENSES/Apache-2.0.txt)) — not the AGPL — so that building,
depending on, or starting from them does not carry any AGPL obligation into a third-party
plugin. First-party plugins bundled in `plugins/` are unaffected and remain AGPL-3.0-only.
The license shipped with a given version governs that version; future versions may use
different terms.

## 5. Third-party dependencies

Dependencies retain their own licenses; a `THIRD-PARTY-NOTICES` file is generated for each
release (including the Docker image). Two notes:

- The subtitle renderer (`akarisub`) bundles WebAssembly builds of libass (ISC), fribidi
  (LGPL-2.1 — the LGPL component), FreeType (FTL elected), fontconfig, harfbuzz, expat, and
  brotli; their notices and corresponding-source / relink information are in
  `THIRD-PARTY-NOTICES`, with full license texts in `LICENSES/`. (The GPL-3.0 `rvfc-polyfill`
  once required by the previous renderer is not used by any build.)

## 6. Trademark / affiliation

"Lumastra", its logos, and official artwork are **not** licensed by either the AGPL or the
commercial license — neither code license grants trademark rights. "Lumastra" is the subject of a
European Union trade mark application (EUIPO, filed July 2026, Nice classes 9 and 42). The full
usage policy — what needs no permission (truthful reference, unmodified packages, descriptive
plugin names) and what does (forks, endorsement implications) — is in
[`TRADEMARKS.md`](./TRADEMARKS.md); this section summarizes it. The name and logos may not be
used to imply endorsement, affiliation, or official status, and **a fork or competing distribution
must adopt its own name and branding**. An **unmodified** redistribution or third-party package of
Lumastra (for example `linuxserver/lumastra`, or a distro package named `lumastra`) may use the name
to identify the software it packages — that is identification, not a competing fork — provided it
does not imply it is official or endorsed.

**Brand-asset paths.** The brand assets themselves (logos, icons, official artwork) live under the
paths below and are licensed `LicenseRef-Lumastra-Branding` (all rights reserved; see
[`LICENSES/LicenseRef-Lumastra-Branding.txt`](./LICENSES/LicenseRef-Lumastra-Branding.txt)) — **not**
under the AGPL. They may be redistributed only verbatim, unmodified, as part of a distribution or
package of Lumastra — an Official Distribution **or** a third-party package/image of Lumastra
(e.g. a community container image), matching the license text; a fork or competing distribution
must replace them with its own branding.

- `static/branding/`
- `src/lib/assets/branding/`
- the app-icon renders at the `static/` root — `favicon.ico`, `favicon.png`,
  `icon-192.png`, `icon-192-maskable.png`, `icon-512.png`, `icon-512-maskable.png`,
  `apple-touch-icon.png`, `apple-touch-icon-precomposed.png` — which are size/format
  renders of the Lumastra icon (they must live at the web root to be served at their
  fixed URLs, so they cannot sit under `static/branding/`)

Nominative/descriptive use is fine: a third-party plugin, extension, or integration built for the
project may reference the name to describe what it works with — e.g. naming a package
`lumastra-<something>` or "… for Lumastra" — as long as it does not present itself as official or
endorsed.

Third-party names used for compatibility (e.g. "Jellyfin", "Subsonic") are trademarks of their
respective owners and indicate interoperability, not affiliation.
