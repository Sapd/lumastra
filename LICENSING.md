# Licensing

Lumastra is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
Everything is free: there are no paid parts, no license keys and no feature limits.
The full text is in [`LICENSE`](./LICENSE). Copyright holder: **Denis Arnst (Sapd)**.

`-only` (not `-or-later`) is deliberate: nobody can opt into a later AGPL version whose terms
have not been reviewed.

## What is covered

- **All source code** in this repository is `AGPL-3.0-only`. That includes the Jellyfin-compatible
  `/j` API and the AI assistant. Earlier releases (0.1.x) published these two parts under
  source-available terms; they are also available under `AGPL-3.0-only`, and from 0.2.0 on they
  are plain AGPL like everything else.
- **Plugin SDK and sample plugins** (`packages/@sapd/lumastra-plugin-sdk*`, `examples/plugins/`) are
  `Apache-2.0` ([`LICENSES/Apache-2.0.txt`](./LICENSES/Apache-2.0.txt)), so a plugin author does not
  inherit AGPL obligations. Plugins bundled in `plugins/` stay AGPL.
- **Brand assets** (logos, icons, official artwork) are `LicenseRef-Lumastra-Branding`, all rights
  reserved ([`LICENSES/LicenseRef-Lumastra-Branding.txt`](./LICENSES/LicenseRef-Lumastra-Branding.txt)).
  They may be redistributed unmodified as part of a Lumastra distribution or package. A fork must
  replace them with its own branding. The paths:
  - `static/branding/` and `src/lib/assets/branding/`
  - the app-icon renders at the `static/` root: `favicon.ico`, `favicon.png`, `icon-192.png`,
    `icon-192-maskable.png`, `icon-512.png`, `icon-512-maskable.png`, `apple-touch-icon.png`,
    `apple-touch-icon-precomposed.png`
- **Third-party dependencies** keep their own licenses. The notices are in
  [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md), with license texts in `LICENSES/`.

Per-file `SPDX-License-Identifier` headers state the license of each file. A file without a
header (images, fonts) follows the rule for its directory above.

## Your own branding

Showing your own name and logo in your own installation (Settings → Branding) is free and needs
no permission.

## Trademark

"Lumastra", its logos and official artwork are not licensed by the AGPL. The name may not be used
to imply endorsement or official status, and a fork or competing distribution must use its own
name and branding. Unmodified packages (for example a container image or a distro package) may use
the name to say what they package. Plugins and integrations may say they are "for Lumastra". The
full policy is in [`TRADEMARKS.md`](./TRADEMARKS.md). "Jellyfin", "Subsonic" and other names used for
compatibility belong to their owners and do not imply affiliation.

## Contributions

Contributions are accepted under the [Contributor License Agreement](./.github/CLA.md) and are
released under `AGPL-3.0-only` ([`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md)).

## Network calls to lumastra.org

Lumastra needs no license check and makes none. One call to the project's servers remains, for
push notifications to the iPhone and Apple TV apps:

| | |
| --- | --- |
| **Endpoint** | `POST https://lumastra.org/api/push/relay-token` |
| **When** | Only while push notifications are on, delivery uses the standard relay (no own Apple key), no `PUSH_RELAY_TOKEN` is set and **Contact lumastra.org for the push relay token** (`LICENSE_SERVER_CONTACT_ENABLED`) is on. About every 6 hours. |
| **Sent** | `install_uuid` (a random per-installation ID, readable at **/admin/system/instance**) and `app_version`. Nothing else: no titles, paths, accounts, library data or IP-derived data beyond what any web request carries. |
| **Received** | A relay token, valid for at most 24 hours, held in memory and in the cache. |

Push messages themselves go to `https://push.lumastra.org`, which receives device push tokens and a
content-free banner. Turn push off, use your own Apple key, run your own relay
(`PUSH_RELAY_URL` + `PUSH_RELAY_TOKEN`), or switch the setting off and nothing is sent to
lumastra.org. Blocking `lumastra.org` only stops push through the standard relay.

Features you enable (metadata providers, AI, and so on) make their own calls; they are listed at
<https://lumastra.org/reference/data-flows/>.

Installs older than 0.2.0 may still call the old `/api/license/*` endpoints until they update.
Updating to 0.2.0 removes the key, the weekly check-in and every limit.
