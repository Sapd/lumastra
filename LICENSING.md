# Licensing

Lumastra is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`).
Everything is free: there are no paid parts, no license keys and no feature limits. The iPhone,
iPad and Apple TV apps are not in this repository. They are closed source and free of charge.
The full text is in [`LICENSE`](./LICENSE). Copyright holder: **Denis Arnst (Sapd)**.

`-only` (not `-or-later`) is deliberate: nobody can opt into a later AGPL version whose terms
have not been reviewed.

## What is covered

- **All of Lumastra's own source code** in this repository is `AGPL-3.0-only`. That includes the
  Jellyfin-compatible `/j` API and the AI assistant. A few vendored third-party files keep their
  own license (for example the Jellyfin device profiles, GPL-3.0); they are listed in
  [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md). The directories named `proprietary` are a
  historical name; the files in them are `AGPL-3.0-only`, as their headers say.
- **Releases before 0.2.0.** In the 0.1.x releases the `/j` API and the AI assistant were
  source-available: their files carried a source-available license identifier in their headers and lived in
  `src/lib/server/proprietary/`, `src/lib/proprietary/`, `src/routes/(proprietary)/`,
  `src/routes/api/(proprietary)/`, `src/lib/server/api/defs/integrations/jellyfin-quick-connect*`
  and `tests/jellyfin-contract/`. The copyright holder, Denis Arnst, also licenses those files, as
  published in every 0.1.x release, under `AGPL-3.0-only`. The headers and `LICENSING.md` inside
  the old release tags are not rewritten; this statement applies to them. Brand assets are
  excluded.
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
released under `AGPL-3.0-only` ([`.github/CONTRIBUTING.md`](./.github/CONTRIBUTING.md)). The CLA
also lets the copyright holder license contributions under other terms, and promises that merged
contributions stay available in the public repository under AGPL-3.0 or another OSI-approved
license (CLA §3). You keep your copyright.

## Network calls to lumastra.org

Lumastra makes no license check. It contacts the project's servers for two things: the daily
update check (lumastra.org) and push notifications to the Apple apps (a token request to
lumastra.org, and the push messages themselves to push.lumastra.org). Both lumastra.org calls are
switched by **Contact lumastra.org (update check, push relay)** (`LICENSE_SERVER_CONTACT_ENABLED`),
on by default.

**Update check.** Once a day, one scheduled task (not one per replica) sends
`GET https://lumastra.org/api/update-check?v=<version>` and gets the latest release list back, so
the admin notice can show new releases and the red "Security: yes" notice. The request carries the
Lumastra version and nothing else: no install ID, no hash, no cookie. lumastra.org counts it in
aggregate by version, date and Cloudflare's country for the request, and stores no IP address, so
nothing links two requests. Like any web request it reveals your server's IP address to the
network path and to Cloudflare. If lumastra.org does not answer, Lumastra reads GitHub's release
list (`api.github.com`) instead. With the contact setting off, it reads GitHub only and sends
nothing to lumastra.org. **Check for Lumastra updates** (`UPDATE_CHECK_ENABLED`) off stops the
check altogether.

|              |                                                                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Endpoint** | `POST https://lumastra.org/api/push/relay-token`                                                                                                                                                                                                                                                                      |
| **When**     | Only while push notifications are on, delivery uses the standard relay (no own Apple key), no `PUSH_RELAY_TOKEN` is set and **Contact lumastra.org (update check, push relay)** is on, which is the default. About every 6 hours.                                                                                     |
| **Sent**     | `install_uuid` (a random per-installation ID, readable at **/admin/system/instance**) and `app_version`. The token is bound to the installation, which is why the ID is sent on every renewal. No titles, paths, accounts or library data. Like any web request, it reveals your server's IP address to lumastra.org. |
| **Received** | A relay token, valid for at most 24 hours, held in memory and in the cache.                                                                                                                                                                                                                                           |

The stored name `LICENSE_SERVER_CONTACT_ENABLED` is historical and kept so existing opt-outs keep
working; it no longer has anything to do with a license.

Push messages go to `https://push.lumastra.org`, which receives device push tokens and a
content-free banner. Turn push off, use your own Apple key, run your own relay
(`PUSH_RELAY_URL` + `PUSH_RELAY_TOKEN`), or switch the setting off and nothing is sent to
lumastra.org. Blocking `lumastra.org` only stops push through the standard relay.

A daily check for new releases reads the public GitHub releases list of `Sapd/lumastra`
(`api.github.com`) and sends no install data. `UPDATE_CHECK_ENABLED` switches it off.

Features you enable (metadata providers, AI, and so on) make their own calls; they are listed at
<https://lumastra.org/reference/data-flows/>.

Installs older than 0.2.0 call the old `/api/license/*` endpoints, which will be switched off
after 0.2.0 [date]. Updating to 0.2.0 removes the key, the weekly check-in and every limit.
<!-- DATE: set at release -->
