# Third-Party Notices

This file lists third-party software distributed in, or fetched at runtime by, the
Lumastra Docker image, together with their licenses and — where the license requires it
(GPL/LGPL/AGPL) — how to obtain the corresponding source.

It exists to satisfy the attribution and "corresponding source" obligations of the
copyleft components Lumastra ships. It is referenced by [`LICENSING.md`](./LICENSING.md) §5.

> **Scope.** Lumastra's own code is licensed per its per-file `SPDX-License-Identifier`
> (`AGPL-3.0-only` by default; `LicenseRef-Lumastra-Proprietary` for the `/j` and AI-assistant
> trees — see [`LICENSING.md`](./LICENSING.md)). The third-party components below are **separate
> works**, each under its own license. The copyleft binaries (Essentia, ffmpeg, fpcalc) are
> invoked by Lumastra **as separate processes** (CLI/subprocess), which is mere aggregation, not
> derivation — they do not place Lumastra's code under their licenses.

Full verbatim texts of the third-party licenses referenced below — LGPL-2.1, LGPL-3.0 (and the
GPL-3.0 it supplements), the FreeType License (FTL), MPL-2.0, and SIL OFL-1.1 — ship in
[`LICENSES/`](./LICENSES/) and are included in the Docker image alongside this file.

---

## 1. Bundled / fetched native binaries

These are **separate programs** invoked by Lumastra over a process boundary (exec / CLI).

### Essentia audio extractor — **AGPL-3.0**

- **What:** `essentia_streaming_extractor_music` (the `streaming_extractor_music` binary from
  `essentia-extractors-v2.1_beta2-linux-x86_64`).
- **Where:** baked into the image at `/usr/local/bin/` (amd64 only; see `Dockerfile`).
- **Upstream:** Essentia, Music Technology Group, Universitat Pompeu Fabra — <https://essentia.upf.edu/>
- **License:** GNU Affero General Public License v3.0.
- **Corresponding source:** the binary is the **unmodified** upstream release. Its complete
  corresponding source for the pinned version is available from the upstream project:
    - Release/binary: <https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-linux-x86_64.tar.gz>
    - Source: <https://github.com/MTG/essentia> (tag/commit corresponding to `v2.1_beta2`)
    - We additionally make the same corresponding source available on request — see §4.

### jellyfin-ffmpeg (FFmpeg) — **GPL-3.0**

- **What:** `ffmpeg` / `ffprobe`, used for transcoding, probing, frame extraction.
- **Where:** **not** baked into the image — fetched at runtime by `scripts/fetch-ffmpeg.sh`
  into `$FFMPEG_CACHE_DIR` (`/config/bin`), pinned to `FFMPEG_VERSION=v7.1.4-3`.
- **Upstream:** <https://github.com/jellyfin/jellyfin-ffmpeg> (release `v7.1.4-3`); FFmpeg —
  <https://ffmpeg.org/>
- **License:** GNU General Public License v3.0 (jellyfin-ffmpeg is built `--enable-gpl`).
- **Corresponding source:** unmodified upstream release.
    - Binaries + build config: <https://github.com/jellyfin/jellyfin-ffmpeg/releases/tag/v7.1.4-3>
    - FFmpeg source: <https://github.com/FFmpeg/FFmpeg> (and <https://ffmpeg.org/download.html>)
    - Also available on request — see §4.

### Chromaprint / `fpcalc` — **LGPL-2.1+ (library) / GPL-2.0+ (`fpcalc` tool)**

- **What:** `fpcalc` (acoustic fingerprinting), from Ubuntu's `libchromaprint-tools` package.
- **Where:** installed via `apt` in the image at `/usr/bin/fpcalc`.
- **Upstream:** <https://github.com/acoustid/chromaprint>
- **License:** Chromaprint library — LGPL-2.1-or-later (full text in
  [`LICENSES/LGPL-2.1-or-later.txt`](./LICENSES/LGPL-2.1-or-later.txt)); the `fpcalc`
  command-line tool — GPL-2.0-or-later.
- **Corresponding source:** Ubuntu source package `chromaprint` for the installed version
  (`apt-get source chromaprint`), or upstream above. Available on request — see §4.

### GPU userspace, Intel / AMD — **MIT and other open licenses + redistributable Intel binaries**

- **What:** VA-API / QSV / OpenCL userspace that the runtime-fetched jellyfin-ffmpeg loads for
  hardware transcode (amd64 only; install is non-fatal — the app falls back to software
  transcode): `intel-media-va-driver-non-free` (iHD), `libmfx-gen1` + `libvpl2` (oneVPL/QSV
  runtime), `intel-opencl-icd` (OpenCL, HDR→SDR tonemapping), `libigdgmm12`, plus
  `mesa-va-drivers` (AMD VA-API), `libva2`, `libva-drm2`, `vainfo`. NVIDIA userspace is **not**
  in the image (injected at runtime by the host's nvidia-container-toolkit).
- **Where:** the Intel packages come from Intel's official GPU apt repository
  (<https://repositories.intel.com/gpu/ubuntu>, suite `noble client`); mesa/libva/vainfo from
  the Ubuntu 24.04 archive.
- **License:** libva, mesa, and vainfo are MIT-licensed; the Intel media driver and compute
  runtime are MIT/Apache-style open source with additional redistributable Intel binary
  firmware/microcode components (the "non-free" naming), freely redistributable under Intel's
  terms.
- **Source:** <https://github.com/intel/media-driver>, <https://github.com/intel/compute-runtime>,
  <https://github.com/intel/libvpl>, <https://gitlab.freedesktop.org/mesa/mesa>; or
  `apt-get source <pkg>` against the respective apt repository.

### Ubuntu base image packages

The runtime base is `ubuntu:24.04` ("noble"). Node.js 24, npm and Corepack are copied
from the official `node` Docker image, pinned by patch version and multi-architecture index
digest in `Dockerfile`. Node.js is MIT-licensed with bundled third-party notices; its full
license ships at `/usr/local/share/doc/node/LICENSE`. Source: <https://github.com/nodejs/node>.
`tsx` (MIT) is a pinned production dependency installed by `npm ci`, not a global install.
Additional `apt` packages include `curl`, `ca-certificates`, `gnupg`, `xz-utils`, `procps`,
`libstdc++6`, `libgcc-s1`, `libatomic1`, `libjemalloc2`, `fontconfig`, `fonts-dejavu-core`,
`tini` (and the chromaprint/GPU packages above). Each retains its distribution-declared
license; corresponding source is available via `apt-get source <pkg>` against the Ubuntu
noble archive (or Intel's repository for GPU packages), or on request — see §4.

---

## 2. Bundled npm dependencies, fonts & assets

The production `node_modules` tree shipped in the image is **overwhelmingly permissive**: 191
packages, of which 141 MIT, 16 Apache-2.0, 6 Apache-2.0 WITH LLVM-exception, 16 BSD, 3 ISC, 2
Unlicense and 1 0BSD (`npm run licenses`, 2026-10-06, linux-x64). The copyleft / notable exceptions are listed below.

### sharp / libvips — **LGPL-3.0-or-later**

- **What:** image processing (`sharp`), backed by `libvips` prebuilt binaries
  (`@img/sharp-libvips-linux-x64` / `@img/sharp-libvips-linux-arm64` in the image).
- **License:** sharp itself is Apache-2.0; the bundled libvips binaries are LGPL-3.0-or-later.
- **Compliance:** LGPL — used as a dynamically loadable library; the relink/replace right is
  preserved because the libvips binary is a separate, replaceable artifact in `node_modules`.
  Full texts: [`LICENSES/LGPL-3.0-or-later.txt`](./LICENSES/LGPL-3.0-or-later.txt) together with
  [`LICENSES/GPL-3.0-only.txt`](./LICENSES/GPL-3.0-only.txt) (LGPL-3.0 is a set of additional
  permissions on top of GPL-3.0).
- **Source:** <https://github.com/libvips/libvips>

### akarisub (subtitle renderer WASM) — **LGPL-2.1+ / FTL / MIT / ISC / …**

- **What:** `akarisub@1.1.3` — subtitle (ASS/SSA) rendering in the browser; a maintained fork of
  jassub (wrapper lineage: AkariSub → JASSUB → SubtitlesOctopus contributors, all MIT — see the
  package's own `LICENSE`, which carries all three copyright lines). The 1.x line ships **two**
  WebAssembly binaries, both as separate, replaceable client assets emitted by Vite into
  `_app/immutable/assets/`:
    - `pkg/akarisub.wasm` — the baseline build (always loaded).
    - `pkg/akarisub-mt.wasm` — a pthread/SIMD build used only when the page is
      `crossOriginIsolated` (COOP/COEP; gated in `wasm-capabilities.js`). No COOP/COEP headers
      are set anywhere in this repo, so in practice it is emitted but never fetched — it is
      covered here regardless, because it ships in the image.

    Each binary compiles in several libraries, each under its own license. Versions below are the
    submodule pins recorded by the installed package's own notice file:
    - **libass** `3fef2c1` — ISC (<https://github.com/libass/libass>). Upstream's README for
      1.1.3 points at libass proper; the pinned commit is the authoritative identifier for the
      exact bundle.
    - **fribidi** `v1.0.16-5-g069a7e3` — **LGPL-2.1-or-later**
      (<https://github.com/fribidi/fribidi>) — this is the LGPL component of the bundle; the
      attribution, license-text, and corresponding-source obligations attach here. Full text:
      [`LICENSES/LGPL-2.1-or-later.txt`](./LICENSES/LGPL-2.1-or-later.txt).
    - **FreeType** `VER-2-14-3-81-g9e9d3b73f` — dual `FTL OR GPL-2.0-or-later`; Lumastra elects
      the **FreeType License (FTL)** branch. Full text: [`LICENSES/FTL.txt`](./LICENSES/FTL.txt).
      As the FTL requires: _Portions of this software are copyright © 2026 The FreeType Project
      (<https://www.freetype.org>). All rights reserved._
    - **harfbuzz** `14.3.0` (Old MIT), **fontconfig** `2.18.3` (HPND-style with additional
      notices), **expat** `R_2_8_2` (MIT), **brotli** `v1.2.0-145-g8e10eeb` (MIT).
    - **Emscripten runtime** `6.0.6` (`pkg/akarisub.js`, `pkg/akarisub-mt.js` — the generated JS
      glue, emitted alongside each `.wasm`) — dual `MIT OR NCSA`; Lumastra elects **MIT**. Full
      text: [`LICENSES/MIT.txt`](./LICENSES/MIT.txt).
    - The bundled fallback font (`assets/default.woff2`, Liberation Sans, OFL-1.1) is covered
      under "Bundled fonts" below rather than here.

- **Metadata note:** the npm package declares `"license": "MIT"`, which describes only the JS
  wrapper — this entry is authoritative for the components inside the bundled WASM. Upstream's
  generated per-library copyright/notice file ships verbatim as
  [`LICENSES/THIRD-PARTY-NOTICES-akarisub-COPYRIGHT.txt`](./LICENSES/THIRD-PARTY-NOTICES-akarisub-COPYRIGHT.txt)
  (a byte-for-byte copy of `THIRD_PARTY_NOTICES.md` from `akarisub@1.1.3`; it contains the full
  license text of every component listed above). Refresh it from the installed package whenever
  akarisub is upgraded.
- **Compliance:** this notice + the license texts in `LICENSES/` + upstream source. The LGPL
  relink/replace right is preserved because each WASM binary is a discrete, runtime-loaded file a
  user can rebuild from upstream and substitute. Corresponding source for the exact bundle: the
  akarisub release it was built from (1.1.3, submodule pins above), and on request per §4. See
  the commercial-track caveat in §5.
- **Source:** <https://github.com/altqx/akarisub>

### rvfc-polyfill — not used

- The GPL-3.0 `rvfc-polyfill` package is **not** a dependency of any build. The previous
  subtitle renderer (`jassub`) required it — Lumastra shipped an in-repo MIT shim in its place —
  but `akarisub` feature-detects the native `requestVideoFrameCallback` API and needs no
  polyfill. Neither the GPL package nor any replacement ships on either distribution track.

### MPL-2.0 packages

File-level copyleft; no effect on Lumastra's own files. Used unmodified; source is available
from each package's repository, and the full license text ships in
[`LICENSES/MPL-2.0.txt`](./LICENSES/MPL-2.0.txt).

- **@jellyfin/sdk** — MPL-2.0 — <https://github.com/jellyfin/jellyfin-sdk-typescript>
- **dompurify** — dual `(MPL-2.0 OR Apache-2.0)`; Lumastra elects **Apache-2.0**, so no
  copyleft obligation applies — <https://github.com/cure53/DOMPurify>
- **lightningcss** (+ its platform binary, e.g. `lightningcss-linux-x64-gnu`) — MPL-2.0 — reaches
  the production tree through `@inlang/paraglide-js → vite`; a build-time CSS tool that the
  runtime app does not load — <https://github.com/parcel-bundler/lightningcss>

### @lix-js/sdk native binary — **MIT**

- `@lix-js/sdk-linux-x64@0.17.0` (and its other platform variants) reports `UNKNOWN` to license
  scanners because its `package.json` has no `license` field. It is the native binary of
  `@lix-js/sdk`, which is MIT (Opral, <https://github.com/opral/lix>). No copyleft obligation.
- It is a **build-time-only** transitive dependency of the i18n compiler
  (`@inlang/paraglide-js → @inlang/sdk → @lix-js/sdk`). The runtime app imports only paraglide's
  generated output (`src/lib/paraglide/`), never this package — it is not in the server or browser
  bundle. (Earlier versions pulled in `sqlite-wasm-kysely` here; it is no longer in the tree.)

### Jellyfin device profiles — **GPL-2.0 / GPL-3.0**

- **What:** five transcoding device profiles (Android TV, Chrome, Roku, Tizen, webOS) in
  `src/lib/server/services/transcoding/profiles/`, adapted from the Jellyfin server's test data
  (`tests/Jellyfin.Model.Tests/Test Data/DeviceProfile-*.json`). The profile folder's
  `README.md` lists each source file and what was changed. `apple-tv.json` is Lumastra's own.
- **Upstream:** <https://github.com/jellyfin/jellyfin> — Copyright (C) Jellyfin Contributors.
- **License:** Jellyfin is GPL-2.0 ([`LICENSES/GPL-2.0-only.txt`](./LICENSES/GPL-2.0-only.txt))
  and publishes the `MediaBrowser.Model` package that defines this format under GPL-3.0.
  Lumastra uses the files under GPL-3.0 ([`LICENSES/GPL-3.0-only.txt`](./LICENSES/GPL-3.0-only.txt)),
  which may be combined with AGPL-3.0 code (section 13 of both licenses).
- **Corresponding source:** the modified files themselves, in this repository.

### libbitsub — **MIT**

- **What:** `libbitsub@1.13.0` — bitmap (PGS/VobSub) subtitle rendering in the browser
  (Rust→WASM). Bundled from the npm package by Vite (`vite.config.ts` patches its WASM URL
  resolution); no copy is vendored into the tree.
- **License:** MIT — Copyright (c) 2026 Jaruwit Jaiya ("altqx"). No copyleft obligation; the
  copyright notice above is reproduced here because the vendored files carry no header.
- **Source:** the `libbitsub` npm package.

### Bundled fonts — **SIL OFL 1.1**

Three font files ship in the image and the browser app. All are licensed under the SIL Open
Font License 1.1 — full text in [`LICENSES/OFL-1.1.txt`](./LICENSES/OFL-1.1.txt). Inter and
Space Grotesk are redistributed as Latin-subset WOFF2 builds of the upstream releases
(subsetting/format conversion is permitted by the OFL); Liberation Sans is redistributed
unmodified.

- **Inter** (`src/lib/assets/fonts/inter-latin-variable-full.woff2`) — the application UI font.
  Copyright © The Inter Project Authors (Rasmus Andersson). <https://rsms.me/inter/>
- **Space Grotesk** (`src/lib/assets/fonts/space-grotesk-latin-variable.woff2`) — used for
  calendar dates and the highlighted movie name in "Because you watched" titles. Copyright ©
  2020 The Space Grotesk Project Authors (Florian Karsten).
  <https://github.com/floriankarsten/space-grotesk>
- **Liberation Sans** (`node_modules/akarisub/assets/default.woff2`, emitted by Vite as
  `_app/immutable/assets/default.<hash>.woff2`) — the subtitle renderer's default/fallback
  font, registered as `'liberation sans'`. Redistributed as shipped by `akarisub`; the repo
  no longer vendors a byte-identical second copy in `static/`. Copyright © Red Hat, Inc.;
  digitized data © Google (Croscore-derived, Liberation Fonts 2.x).
  <https://github.com/liberationfonts/liberation-fonts>

### UI icons — **Heroicons (MIT)**

Several navigation icons in `static/icons/` (e.g. `home.svg`, `movies.svg`, `browse.svg`,
`search.svg`, `watchlist.svg`, `requests.svg`, `audiobooks.svg`) are from, or derived from,
**Heroicons v2** — Copyright © Tailwind Labs, Inc., MIT license
(<https://github.com/tailwindlabs/heroicons>; text in [`LICENSES/MIT.txt`](./LICENSES/MIT.txt)).

### Third-party marks and data sources

- **TMDB:** this product uses the TMDB API but is not endorsed or certified by TMDB. Metadata
  and artwork supplied by TMDB remain subject to TMDB's terms
  (<https://www.themoviedb.org/terms-of-use>); the TMDB logo (`src/lib/assets/providers/tmdb.svg`)
  is TMDB's mark, used solely for the attribution TMDB requires.
- **Service logos** (`static/icons/`, `static/providers/`, `src/lib/assets/providers/`): logos of
  Sonarr, Radarr, Lidarr, Prowlarr, Tautulli, Grafana, Pelican Panel, Wiki.js, and similar are
  trademarks of their respective owners. They are used nominatively — to identify the service a
  configured link or integration points at — and imply no affiliation or endorsement. They are
  **not** covered by Lumastra's licenses and remain the property of their owners; a redistribution
  that removes those integrations should remove the marks as well.
- **IMDb / Rotten Tomatoes:** ratings sourced from MDBList are attributed by name only —
  Lumastra does not ship the IMDb or Rotten Tomatoes logos (their owners restrict use of the
  marks); the UI shows a plain "IMDb"/"RT" text label instead, which is nominative use and
  implies no affiliation or endorsement. An operator who independently holds permission to
  display those logos may mount their own logo files and point the `RATING_LOGO_IMDB` /
  `RATING_LOGO_ROTTEN_TOMATOES` settings at them — doing so is the operator's own
  responsibility, not a license granted by Lumastra.
- **Decorative images** (`static/placeholders/popcorn.jpg`,
  `static/placeholders/lumastra-various-artists.webp`, `src/lib/assets/back12-blurred.avif`,
  `src/lib/assets/back12-blurred.webp`):
  first-party works created by the copyright holder, partly with generative tools, who holds
  all rights in them to the extent they are protectable — **no third-party assets**. They are
  covered by the repository's normal path-based licensing (LICENSING.md §1), not by this
  notices file; they are listed here only to document their provenance. (Holiday background
  images of uncertain provenance were removed on 2026-09-12; the holiday themes now use
  colours only.)

### Sonic-embedder sidecar image (`workers/sonic-embedder/`)

A separate, optional Python service image (not part of the main app image). Its Python
dependencies are permissively licensed (`msclap` MIT, `librosa` ISC, `soundfile` BSD-3,
`pyloudnorm` MIT, `umap-learn` BSD-3, `scikit-learn` BSD-3, `fastapi` MIT, `uvicorn` BSD-3),
with two notes:

- **psycopg2-binary** — **LGPL-3.0 with linking exception**. Imported dynamically as an
  unmodified, separately replaceable Python package; corresponding source at
  <https://github.com/psycopg/psycopg2> (see also §4).
- **PyTorch base image** (`pytorch/pytorch` CUDA runtime): `torch` is BSD-3-Clause; the CUDA /
  cuDNN libraries it contains are redistributed under NVIDIA's container/EULA terms exactly as
  in the upstream base image. The CLAP model weights (`microsoft/msclap`, MIT) are fetched from
  Hugging Face at runtime, not distributed in the image.

---

## 3. Generating an up-to-date dependency manifest

The lists above are curated. A full machine-generated manifest of every npm dependency and its
license should be produced for releases, e.g.:

```bash
npm run licenses   # writes third-party-npm-licenses.json
```

---

## 4. Written offer for corresponding source

For any GPL/LGPL/AGPL component distributed in or fetched by the Lumastra image, the complete
corresponding source code is available from the upstream locations cited above. In addition, for
a period of three years, the copyright holder will provide, on request, the complete
corresponding source for the exact versions distributed, at no charge beyond the cost of
distribution.

**Contact:** <git@sapd.eu>

---

## 5. Commercial-license caveats

The notes above describe the **AGPL** distribution, under which GPL/LGPL components are fully
compatible. The separate commercial license (see [`LICENSING.md`](./LICENSING.md) §2) removes the
AGPL's source-disclosure obligations. The bundled third-party components remain compatible with
that track:

- **rvfc-polyfill:** not used at all — `akarisub` needs no `requestVideoFrameCallback`
  polyfill, so the GPL-3.0 upstream package is absent from every build.
- **akarisub / fribidi / FreeType:** Lumastra elects the **FreeType License (FTL)** branch and
  satisfies the LGPL-2.1 attribution/relink terms for **fribidi** (the LGPL component of the
  akarisub WASM — libass itself is ISC) via this notice, the license texts in `LICENSES/`, and
  the written source offer in §4. These obligations apply equally under both tracks.
- **Essentia (AGPL-3.0), jellyfin-ffmpeg (GPL-3.0), `fpcalc` (GPL-2.0):** invoked as separate
  processes (mere aggregation), so they impose no copyleft on Lumastra's own code under either
  track. Their binaries remain under their respective licenses, and the notice / corresponding-source
  obligations in this file still apply when those binaries are redistributed.

---

## 6. Third-party artwork

- **audiobookshelf logos:** the unmodified icon at
  [`src/lib/assets/providers/audiobookshelf.png`](./src/lib/assets/providers/audiobookshelf.png)
  comes from the [audiobookshelf project website](https://audiobookshelf.org/img/Logo.png)
  (retrieved 2026-10-04). The full logo at
  [`src/lib/assets/providers/audiobookshelf-full.svg`](./src/lib/assets/providers/audiobookshelf-full.svg)
  comes from the [upstream banner](https://github.com/advplyr/audiobookshelf/blob/e4ad622c017f7ab7d16ab720184ee08298ba3348/images/banner.svg)
  (retrieved 2026-10-09). The full logo’s lettering is outlined using the
  [Gentium Basic and Gentium Book Basic fonts](https://github.com/google/fonts/tree/99defd20c9d050b5dd6be3450f94d96439d13678/ofl)
  so it renders without installed fonts; the tagline is lightened for dark backgrounds.
  The name and logos identify the audiobook integration;
  they remain the property of their respective owners. Lumastra's code licenses
  do not grant trademark rights or imply endorsement by audiobookshelf.

## 7. External metadata services

Metadata, artwork, lyrics and popularity data are separate from Lumastra's code
license. Settings → About credits the configured sources with links to their
projects; the source list is computed server-side without exposing credentials.
TMDB's logo and required non-endorsement notice appear only with a configured
TMDB credential. Music credits appear when the instance has a music library.

- **TMDB:** [attribution requirements](https://developer.themoviedb.org/docs/faq).
- **Discogs:** [API terms](https://support.discogs.com/hc/en-us/articles/360009334593-API-Terms-of-Use)
  require “Data provided by Discogs” adjacent to API-derived data, linked to the
  corresponding Discogs entry. A general About credit does not replace that
  per-item attribution. Artist and album enrichment now retain the selected
  provider per field in plugin-owned metadata; detail pages and normal-navigation
  modals show direct item links next to the displayed artwork/biography/genre.
  Rejected or failed artwork is not credited; Cover Art Archive replacements
  carry their own source. Historical rows without provenance remain uncredited:
  their source cannot be reconstructed honestly. Version upgrades retry missing
  artwork; existing artwork with unknown ownership is preserved. A deliberate
  force re-enrichment removes plugin provenance together with plugin-owned data.
- **TheAudioDB:** [terms](https://www.theaudiodb.com/docs_terms_of_use.php)
  require acknowledgement of the source for its custom artwork.
- **Last.fm:** [API terms](https://www.last.fm/api/tos) require credit, branding,
  and links to relevant catalogue pages. Artist and track popularity badges now
  link to validated HTTPS artist/track URLs retained in provider readouts, with
  the Last.fm homepage as a fallback for missing or invalid historical URLs.
  Local popularity remains unlinked. The legacy [resources page](https://www.last.fm/resources)
  returned HTTP 404 when checked on 2026-10-09, so the prescribed “powered by
  AudioScrobbler” button could not be retrieved. We use the current official
  Last.fm masthead logo instead, sourced from
  [Last.fm's logo asset](https://www.last.fm/static/images/logo_static@2x.11f9df44aefc.png)
  (referenced by its current website stylesheet), stored unchanged at
  `static/attribution/lastfm-logo.png`. This describes the implemented credit,
  not a claim of comprehensive compliance with the legacy branding requirement.
- **MusicBrainz:** [data licenses](https://musicbrainz.org/doc/About/Data_License)
  distinguish CC0 core data from CC BY-NC-SA 3.0 supplementary data.
- **Cover Art Archive:** [project](https://coverartarchive.org/). Cover images
  remain subject to their respective owners' rights.
- **Deezer:** [developer terms](https://cdn-content.dzcdn.net/pdf/CGU-developers.pdf).
- **AcoustID:** [project and documentation](https://acoustid.org/).
- **LRCLIB:** [project and API documentation](https://lrclib.net/docs).
- **MDBList** and **OMDb:** [MDBList](https://mdblist.com/) and
  [OMDb](https://www.omdbapi.com/) are credited when their API keys are configured.

ListenBrainz currently appears in popularity types/presentation helpers only;
the implemented popularity task supports Last.fm. No ListenBrainz credit is
shown for an integration that does not fetch its data.
