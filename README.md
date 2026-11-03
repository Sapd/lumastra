# Lumastra

[![CI](https://img.shields.io/github/actions/workflow/status/Sapd/lumastra/test.yml?branch=main&label=CI)](https://github.com/Sapd/lumastra/actions/workflows/test.yml)
[![Core licence: AGPL-3.0-only](https://img.shields.io/badge/core_licence-AGPL--3.0--only-blue)](./LICENSING.md)
[![GHCR image](https://img.shields.io/badge/image-ghcr.io%2Flumastra%2Flumastra-blue)](https://github.com/orgs/lumastra/packages/container/package/lumastra)
[![Latest tag](https://img.shields.io/github/v/tag/Sapd/lumastra)](https://github.com/Sapd/lumastra/tags)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/ZhaFYkuqq9)

### Self-hosted movies, series and music

Host your movies, series and music on your own hardware, with personalized discovery
and Audiobookshelf integration. I built Lumastra for myself and use it every day.

**[Website & interactive demo](https://lumastra.org/#preview)** ·
**[Quick start](https://lumastra.org/start/quick-start/)** ·
**[Documentation](https://lumastra.org/start/introduction/)** ·
**[Editions & licensing](https://lumastra.org/guides/licensing/)** ·
**[Under the hood](#under-the-hood)** ·
**[How AI is used](#how-lumastra-is-built-and-how-ai-is-used)**

> [!NOTE]
> **Lumastra is an early release (v0.1).** It runs our own libraries every day, but expect
> rough edges and bugs, especially on hardware and setups we haven't tested. Back up your
> `/config` volume and database, and please [report what breaks](https://github.com/Sapd/lumastra/issues).
> The Apple apps have their own version numbers (1.0.1 at launch), and they are just as early.
> See [known limitations](https://lumastra.org/reference/known-limitations/) before you deploy.

Lumastra is created and maintained by **Denis Arnst (Sapd)**. You might know my work from
[HeadsetControl](https://github.com/Sapd/HeadsetControl), or from
[Audiobookshelf](https://github.com/advplyr/audiobookshelf), where I wrote most of the
OpenID Connect (SSO) support. The official repository is
[github.com/Sapd/lumastra](https://github.com/Sapd/lumastra), and official images are published as
`ghcr.io/lumastra/lumastra`. Forks are welcome under the license, but must use their own name
([`TRADEMARKS.md`](./TRADEMARKS.md)).

**Project status:** Lumastra is for power users who like to tune their setup. It has
more moving parts than Jellyfin: PostgreSQL, Valkey, optional AI keys and more settings.
For minimal setup, Jellyfin or Plex may suit you better. Proper SSO and security
were priorities from the start.

Until 1.0, I'm focusing on bugs and polish rather than new features. Ideas are welcome
in [Discussions](https://github.com/Sapd/lumastra/discussions/categories/features).
I maintain Lumastra because I use it myself. If I can't keep up the pace of the first
months, replies and fixes may take a while; please be patient. If issues grow, I may
split features into a supported core and areas maintained as time allows.

[![Lumastra Home: a playing hero preview followed by a smooth scroll through recommendations and the series calendar](docs/assets/screenshots/home-scroll.gif)](https://lumastra.org/#preview)

_Demo with fictional AI-generated media and a silent sample trailer. Lumastra
supplies no media or TV subscriptions; connect your own sources._

Use Lumastra only with media and sources you have the rights to: your own copies,
public-domain works, or services you're licensed to use.

## What Lumastra does well

- **Single sign-on that works everywhere.** Use Authentik, Authelia, Keycloak or any OIDC
  provider, including on the Apple TV, with no passwords typed on the remote. SSO is part
  of the free core.
- **Native apps** for iPhone, iPad and Apple TV, written in Swift.
- **Watch Together** between the web app and the Apple TV app.
- **Music, all built in:** sonic analysis, a smart queue, DJ crossfades, automatic mixes and
  OpenSubsonic, in the same server as your films. No separate Subsonic server or extra tools needed.
- **Subtitles without burn-in**, including styled ASS/SSA and PGS/VobSub.
- **Recommendations beyond what you own**, plus search by what a film is about.
- **Live TV built for reliable viewing:** shared upstream streams, automatic backup-feed
  failover and optional GPU adaptive quality, with end-to-end playback and failure tests.
- **Media management with review built in:** traceable artwork choices, previewed repairs,
  file-health evidence and episode mappings that match the files you actually have.

The full feature list, area by area, is at
[lumastra.org/start/features](https://lumastra.org/start/features/).

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/browse.webp" alt="Fictional movie and series library in the interactive demo"></td>
    <td width="50%"><img src="docs/assets/screenshots/detail.webp" alt="Fictional movie details with recommendations"></td>
  </tr>
  <tr>
    <td align="center"><sub>Browse your collection</sub></td>
    <td align="center"><sub>Find your next watch</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/music.webp" alt="Music discovery with fictional artists and albums"></td>
    <td><img src="docs/assets/screenshots/livetv.webp" alt="Live TV preview with fictional channels and programmes"></td>
  </tr>
  <tr>
    <td align="center"><sub>Discover music</sub></td>
    <td align="center"><sub>Explore Live TV</sub></td>
  </tr>
</table>

[Try the interactive demo](https://lumastra.org/#preview) to see a fully configured
interface with metadata, artwork, trailers and recommendations, without a server login.
It simulates selected workflows; it isn't a hosted media service.
[View the Home screenshot](docs/assets/screenshots/home.webp).

## Watch and listen on your devices

| Client                                | What to expect                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Native iPhone and iPad apps**       | Built for Lumastra, including offline downloads. Available through [public TestFlight](https://testflight.apple.com/join/m8EUbgJQ).                                                                                     |
| **Native Apple TV app**               | Lumastra on the big screen, with music, audiobooks, Watch Together and Top Shelf. Available through [public TestFlight](https://testflight.apple.com/join/QCfrcmZn).                                                    |
| **Web app**                           | Browse and play in your browser; install as a PWA on desktop or mobile.                                                                                                                                                 |
| **Jellyfin-compatible clients**       | Connect clients such as Jellyfin and Streamyfin directly to Lumastra through its compatibility API. No Jellyfin server is required. Two concurrent bridge streams are free; additional streams are a supporter feature. |
| **Subsonic-compatible music clients** | Connect your preferred music app through the (Open)Subsonic API, included in the free core.                                                                                                                             |

See [connecting third-party apps](https://lumastra.org/using/third-party-players/)
for setup. Native-app downloads are distinct from the web app, which does not
currently offer offline downloads. Live TV recording (DVR) is not available yet.

The iPhone, iPad and Apple TV apps need your server on **HTTPS with a certificate the
device trusts** (for example a reverse proxy with Let's Encrypt). Plain HTTP and
self-signed certificates don't work. They sign in through the **Public API** setting
(Admin → Settings), which is on by default.

## What you need, and what is optional

Lumastra is a standalone media server; it doesn't need a Jellyfin server. Required:
**PostgreSQL 17+ with pgvector** and **Valkey** (or Redis), both provided by the example
compose file. Strongly recommended: a free **TMDB API key** for metadata and artwork. An
**embeddings key** (OpenAI or Voyage AI) enables recommendations, semantic search and
the music-by-sound features. The iPhone, iPad and Apple TV apps need **HTTPS with a
trusted certificate**. Everything else (Audiobookshelf, Kavita, Jellyfin sync, Sonarr,
Radarr, Seerr, MDBList, AcoustID, Last.fm, Discogs, AniDB, the sonic sidecar, the chat
assistant key) is optional and skipped quietly when unset; see
[Optional integrations](https://lumastra.org/guides/integrations/). Metadata or prompts
may be sent to the providers you configure; self-hosting doesn't make an external AI or
metadata service local.

## Free core and supporter features

| Feature                           | Licence                                   | Availability                                                           |
| --------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| Movies & series                   | AGPL-3.0-only                             | Library management, playback and hardware transcoding                  |
| Music                             | AGPL-3.0-only                             | Playback, mixes and music discovery                                    |
| Audiobooks via Audiobookshelf     | AGPL-3.0-only (Lumastra integration)      | Requires an Audiobookshelf server                                      |
| Live TV                           | AGPL-3.0-only                             | Programme guide and playback; no DVR                                   |
| Jellyfin app compatibility (`/j`) | Source-available proprietary              | Two concurrent streams free per server; more with supporter access     |
| Subsonic / OpenSubsonic           | AGPL-3.0-only                             | Connect compatible music apps                                          |
| Watch Together                    | AGPL-3.0-only                             | Synchronized sessions between web and Apple TV                         |
| AI recommendations                | AGPL-3.0-only                             | Recommendations and semantic search; configured providers may charge   |
| AI chat assistant                 | Source-available proprietary              | Supporter feature (free during early access); needs an AI provider key |
| Apple apps                        | Closed source                             | iPhone, iPad and Apple TV; separate from the server                    |
| Plugins                           | AGPL-3.0-only; SDK and samples Apache-2.0 | Bundled plugins are AGPL; third-party plugins have their own licences  |

The `/j` Jellyfin compatibility surface and AI chat assistant ship in this repository as
**source-available, licence-gated proprietary components** under
[`LicenseRef-Lumastra-Proprietary`](./LICENSES/LicenseRef-Lumastra-Proprietary.txt).
Recommendations and their shared data/query layer remain AGPL; see
[`LICENSING.md` §3.1](./LICENSING.md#31-proprietary-tier--licenseref-lumastra-proprietary) and
[§3a](./LICENSING.md#3a-what-stays-agpl-and-the-one-directional-invariant).

The **AGPL-3.0-only core is free**. SSO will never be a paid feature.

The **AI chat assistant** and **additional simultaneous streams through the
Jellyfin-compatible client bridge** are source-available supporter features.
Two bridge streams at a time stay free for the whole server, whoever is watching.
The web app and the iPhone, iPad and Apple TV apps don't use the bridge, so they
aren't limited. Supporter features are currently free during early access; pricing
has not been published. AI provider credentials and usage are separate.

### Why a few parts are source-available

The free core includes hardware transcoding, Live TV, SSO and remote access. The `/j`
bridge takes extra maintenance to follow another project's API; I'd rather new apps use
the fully open, documented `/api/v1`. Donations rarely cover costs, and I hope supporter
features help offset development and hosting. **The iPhone, iPad and Apple TV apps are
closed source.** They're free for now; some features, such as offline downloads, will
probably become paid later. They talk to the server only through the same open `/api/v1`
any other app can use ([building a player](https://lumastra.org/developers/building-a-player/)),
and the LGPL libraries they include are published at
[Lumastra/lgpl-source](https://github.com/Lumastra/lgpl-source). What's open source today
stays open source and maintained; I won't move existing features behind a licence, and
most future features will be open source too (the likely exception is DVR). Contributions
need a Contributor License Agreement; why, and what you keep, is in
[CONTRIBUTING.md](.github/CONTRIBUTING.md) and [LICENSING.md](LICENSING.md). See
[editions and licensing](https://lumastra.org/guides/licensing/) for the current
offering; for licensing or CLA questions, contact <git@sapd.eu>.

## Quick start

```bash
mkdir lumastra && cd lumastra
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Sapd/lumastra/main/docker-compose.example.yml
curl -fsSL -o .env https://raw.githubusercontent.com/Sapd/lumastra/main/.env.example
```

The secrets file must be named exactly `.env`, because compose reads its variables
from it. Generate the three secrets straight into `.env` (macOS and Linux; Windows
users see the [full quick start](https://lumastra.org/start/quick-start/#2-generate-secrets)):

```bash
sed -i.bak \
  -e "s|^DATABASE_PASSWORD=.*|DATABASE_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^CACHE_PASSWORD=.*|CACHE_PASSWORD=$(openssl rand -hex 24)|" \
  -e "s|^# LUMASTRA_MASTER_KEY=.*|LUMASTRA_MASTER_KEY=$(openssl rand -hex 32)|" \
  .env && rm -f .env.bak && chmod 600 .env
```

`LUMASTRA_MASTER_KEY` encrypts every secret Lumastra stores: back it up. In
`docker-compose.yml`, uncomment the media line under `volumes:` of both the `lumastra` and
the `lumastra-worker` service (the worker scans) and point it at your media folder
(`- /path/to/media:/data/media:ro`). Then:

```bash
docker compose up -d
```

Open <http://localhost:3000> and follow the setup wizard. Full walkthrough, including
what to persist and why: **[lumastra.org/start/quick-start](https://lumastra.org/start/quick-start/)**.

Next: put it behind HTTPS. The iPhone, iPad and Apple TV apps need it. See the
**[reverse proxy guide](https://lumastra.org/guides/reverse-proxy/)** for Caddy, nginx,
Traefik and Nginx Proxy Manager. Before you commit to a host, read
**[Known limitations](https://lumastra.org/reference/known-limitations/)**: arm64 gaps,
CPU requirements, scaling rules and the `/config` volume you must never lose.

## Documentation

| You want to…                           | Go to                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Install, configure or deploy           | [Quick start](https://lumastra.org/start/quick-start/) · [Deployment](https://lumastra.org/guides/deployment/)                 |
| See every setting                      | [Environment variables](https://lumastra.org/reference/environment-variables/)                                                 |
| Set up sign-in and SSO                 | [Authentication](https://lumastra.org/guides/authentication/)                                                                  |
| Administer a running server            | [Administration](https://lumastra.org/guides/administration/)                                                                  |
| Connect a TV app or third-party client | [Connecting third-party apps](https://lumastra.org/using/third-party-players/)                                                 |
| Build against the API                  | [API & tokens](https://lumastra.org/developers/api/) · [Building a player](https://lumastra.org/developers/building-a-player/) |
| Write a plugin                         | [Writing a plugin](https://lumastra.org/developers/plugins/)                                                                   |
| Contribute to this repository          | [CONTRIBUTING.md](.github/CONTRIBUTING.md) · [docs/README.md](docs/README.md)                                                  |
| Fix or add documentation               | [Sapd/lumastra-docs](https://github.com/Sapd/lumastra-docs) (every page has an "Edit page" link)                               |

The interactive OpenAPI reference is at [lumastra.org/reference](https://lumastra.org/reference/);
the same long-form API notes ship in this repo at [`docs/api/API.md`](docs/api/API.md) and
are served by every instance at `/api-docs` and `/llms.txt` (after sign-in).

## Under the hood

- **Tracked processing pipeline:** 72 built-in tasks cover scanning, metadata, artwork,
  analysis and embeddings, with crash recovery, watchdogs and circuit breakers.
  ([Task system](https://lumastra.org/architecture/task-system/))
- **Separate web and worker roles:** web replicas serve requests; one worker runs tasks
  and plugins and supervises a Rust file watcher. Valkey coordinates both and lets another
  web process take over a playback session when its server goes away.
- **Playback decisions and HLS remuxing:** per-client direct play, remux or transcode,
  based on codecs, HDR, subtitles and detected encoders; video is re-encoded only when
  needed. ([Playback decisions](https://lumastra.org/architecture/playback-decisions/))
- **Versioned public API and enforced licence boundaries:** more than 300 `/api/v1`
  operations in an OpenAPI spec checked in CI; the open core never imports
  source-available modules.

[Architecture decisions](https://lumastra.org/developers/architecture-decisions/)
explain the choices and tradeoffs.

## How Lumastra is built, and how AI is used

I'm the sole developer and use Claude Code daily for code drafts, fixes, tests,
documentation and design discussions. Architecture, data models, security-sensitive
code and merge decisions remain mine. I read what lands and don't merge code I don't
understand. AI-assisted security reviews helped prepare this release; I verified each
finding against the code. More in [the Lumastra story](https://lumastra.org/about/story/).
AI-assisted contributions are welcome under the same rules: tested end to end on a real
instance, reviewed, and explainable by the author. Details in
[CONTRIBUTING-AI.md](.github/CONTRIBUTING-AI.md).

## Community and support

[![Join the Lumastra Discord](https://img.shields.io/badge/Join%20the%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/ZhaFYkuqq9)

- **Chat and informal help:** the [Discord](https://discord.gg/ZhaFYkuqq9) (`#help` forum,
  one post per question). A Discord conversation doesn't replace a GitHub report.
- **Help and feature proposals:** [GitHub Discussions](https://github.com/Sapd/lumastra/discussions)
  ([Q&A](https://github.com/Sapd/lumastra/discussions/categories/q-a) for questions,
  [Features](https://github.com/Sapd/lumastra/discussions/categories/features) for ideas).
- **Bugs:** the [issue forms](https://github.com/Sapd/lumastra/issues/new/choose).
- **Security vulnerabilities:** privately, following [SECURITY.md](.github/SECURITY.md).
- The [Code of Conduct](.github/CODE_OF_CONDUCT.md) applies on GitHub and Discord.

## Support the project

The easiest way to help: ⭐ star this repository, and tell others about Lumastra. If you want to
do more, you can [sponsor the development on GitHub](https://github.com/sponsors/Sapd).

## Contributing

Contributions are welcome. [`CONTRIBUTING.md`](.github/CONTRIBUTING.md) covers the development
setup, tests, code style and the pull-request process, including that feature ideas go
through [Discussions](https://github.com/Sapd/lumastra/discussions/categories/features) before
any code, and that AI-assisted work is welcome with its extent and model disclosed; contributions are accepted under
the [Contributor License Agreement](.github/CLA.md), which a bot will ask you to sign on your
first pull request. Please also read the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

## Security

Found a vulnerability? Please **do not** open a public issue. Follow the responsible
disclosure process in [`SECURITY.md`](.github/SECURITY.md).

## Thanks

Lumastra stands on a lot of open-source work. A few projects deserve a special mention:

- **[jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg)**: Lumastra's transcoding
  depends on it heavily, and it's really well done. Its developer(s) are also very friendly
  and patiently answered my questions in the past when I used Jellyfin.
- **[Audiobookshelf](https://github.com/advplyr/audiobookshelf)**: Lumastra's audiobook
  support is built on it. Its owner [@advplyr](https://github.com/advplyr) is really friendly
  and a pleasure to work with, which I got to see first-hand while writing its SSO support,
  and its community is exceptionally welcoming too.
- **[AkariSub](https://github.com/altqx/akarisub)** and
  **[libbitsub](https://github.com/altqx/libbitsub)**: render styled ASS/SSA and image-based
  (PGS/VobSub) subtitles in the browser. I contributed a few things to AkariSub, and working
  with their author was a pleasure.
- **[TMDB](https://www.themoviedb.org)** and **[MusicBrainz](https://musicbrainz.org)**: almost
  all metadata and artwork comes from these community-built databases. Without them there
  would be no posters, descriptions or music data.
- **[PostgreSQL](https://www.postgresql.org)** and **[pgvector](https://github.com/pgvector/pgvector)**:
  everything Lumastra stores lives in PostgreSQL, and the recommendations run on pgvector,
  without any extra search infrastructure.
- **[Svelte](https://svelte.dev)** and SvelteKit: the web app is built on them, and I'm a big
  fan.

The full list of third-party components and their licenses is in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).

## License

Lumastra is **open core**. The core is **GNU AGPL-3.0-only** ([`LICENSE`](./LICENSE)).
The plugin SDK (`packages/@sapd/lumastra-plugin-sdk*`) and sample plugins
(`examples/plugins/`) are **Apache-2.0** ([`LICENSING.md` §4](./LICENSING.md#4-plugin-sdk-and-sample-plugin-license)).

The same AGPL core is also available under a **separate, negotiated commercial license**
without the AGPL's copyleft and source-disclosure obligations, including §13. This requires
an individual agreement; it is not a free alternative licence choice. Contact <git@sapd.eu>;
see [`LICENSING.md` §2](./LICENSING.md#2-commercial-license-also-available-dual-licensing).

The `/j` compatibility API and AI assistant are **source-available, licence-gated proprietary
components**, governed by their [own terms](./LICENSES/LicenseRef-Lumastra-Proprietary.txt).
The separate **Enterprise tier** (LMS, compliance reporting and product showcase) is excluded
from this public distribution; its source is supplied only to licensees under a negotiated
agreement ([`LICENSING.md` §3.2](./LICENSING.md#32-enterprise-tier--licenseref-lumastra-enterprise-not-in-this-repository)).

The Lumastra name, logos and brand assets have separate trademark and asset terms; see
[`TRADEMARKS.md`](./TRADEMARKS.md) and [`LICENSING.md` §6](./LICENSING.md#6-trademark--affiliation).
Forks must use their own name and branding.

Every source file carries an `SPDX-License-Identifier` header indicating its license.
Contributions are accepted under a Contributor License Agreement (CLA) that preserves the
project's ability to offer the commercial license.
