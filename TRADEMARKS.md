# Lumastra Trademark Policy

"Lumastra", the Lumastra logo, and the Lumastra icon (together, the "Lumastra marks") are
trademarks of **Denis Arnst (Sapd)**. "Lumastra" is the subject of a European Union trade
mark application filed with the EUIPO in July 2026 (Nice classes 9 and 42; registration
pending). <!-- CHECK at release: is the registration status still "pending"? -->

This repository's code licenses do **not** grant trademark rights: neither the AGPL, nor
any other license in `LICENSES/` (see `LICENSING.md`). The
brand-asset **files** (logos, icons, official artwork under the branding paths) are
additionally licensed `LicenseRef-Lumastra-Branding`, all rights reserved; see
[`LICENSES/LicenseRef-Lumastra-Branding.txt`](./LICENSES/LicenseRef-Lumastra-Branding.txt).

The goal of this policy is the usual one: you should be able to talk about, package, and
build on Lumastra freely, while nobody is misled about what is official and what is not.

## You may, without asking

- **Refer to the software truthfully**: "we run Lumastra", "powered by Lumastra",
  "compatible with Lumastra", screenshots in reviews, articles, tutorials, or talks.
- **Redistribute unmodified builds or packages** of Lumastra under the `lumastra` name,
  with the bundled brand assets intact, for example a community container image
  (`linuxserver/lumastra`) or a distro package, provided the packaging does not imply it
  is official or endorsed. That is identification of what is packaged, not a competing use.
  Packaging changes (paths, build flags, dependency versions, security backports) do not make a
  package a fork.
- **Fork to contribute**: a fork on a hosting platform made to prepare a contribution may keep the
  name and assets. Changes you make to your own installation and do not distribute need no rename.
- **Say what you forked from**: say truthfully that your project is "a fork of Lumastra" or "based
  on Lumastra", in text, not in its name or logo.
- **Name a plugin, extension, or integration descriptively**: `lumastra-<something>`,
  "<something> for Lumastra", as long as it does not present itself as official.

## You may not, without written permission

- Use the Lumastra marks (or confusingly similar names or logos) for a **modified fork or
  derived/competing product**: a fork must adopt its own name and branding. The app's
  custom-branding mechanism (see <https://lumastra.org/reference/environment-variables/#branding>) exists so a rebrand is a
  configuration exercise, not a code hunt.
- Use the marks in a way that implies **endorsement, affiliation, or official status**,
  including in product names, company names, domain names, social-media handles, or
  app-store listings.
- Modify the logos or artwork, or incorporate them into your own marks.

## Third-party marks

Third-party names used in this project for compatibility or metadata purposes, such as
"Jellyfin", "Subsonic", "TMDB", "Trakt", "MyAnimeList", "Last.fm", are trademarks of
their respective owners and indicate interoperability, not affiliation or endorsement.

## Questions / permission requests

Contact: <git@sapd.eu>.
