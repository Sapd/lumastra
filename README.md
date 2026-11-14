# Lumastra

[![CI](https://img.shields.io/github/actions/workflow/status/Sapd/lumastra/test.yml?branch=main&label=CI)](https://github.com/Sapd/lumastra/actions/workflows/test.yml)
[![Licence: AGPL-3.0-only](https://img.shields.io/badge/licence-AGPL--3.0--only-blue)](./LICENSING.md)
[![Discord](https://img.shields.io/badge/Discord-Join%20the%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/ZhaFYkuqq9)

Lumastra is a self-hosted media server for movies, series, music, audiobooks and Live TV. One login on every device, including the TV, and it scales from a single Docker host to a Kubernetes cluster.

![A fictional library in the web app](docs/assets/screenshots/home.webp)

## Why Lumastra

Made for homelabs and clusters. Instead of one big process, Lumastra runs as separate services: the web app, a background worker for scans and analysis, PostgreSQL 17+ with pgvector, and two Valkey servers. A heavy scan can't starve playback of CPU or memory, you add web replicas when more people stream, the worker can move to another node, and a restarting pod doesn't take the whole server down. Large libraries stay fast because PostgreSQL does the searching and sorting. It is Kubernetes-native, and Docker Compose works just as well.

Sign-in works on every device: the built-in login, any OIDC provider, or forward auth (Authentik, Authelia, oauth2-proxy). The iPhone, iPad and Apple TV apps sign in with a code you approve in a browser, so nobody types a password with the TV remote.

Everything lives in one server: films and series next to music with a smart queue, gapless playback and DJ crossfades, audiobooks, and Live TV with backup feeds and one shared upstream stream per channel. Subtitles such as ASS, PGS and VobSub are drawn over the video without burn-in.

Your Jellyfin apps keep working. Lumastra answers the Jellyfin API under `/j`, with no Jellyfin server behind it. Tested apps: Streamyfin, Moonfin and Jellyfin Android TV. Music apps connect through the OpenSubsonic API.

You can also run Jellyfin alongside it on the same media folders. Optional two-way sync keeps watched status and playback position in step, so you can try Lumastra without giving anything up.

## Requirements

Compose starts five containers (web, worker, PostgreSQL, two Valkey); 8 GB of RAM is recommended. Lumastra needs its own domain, not a subpath, and the Apple apps need HTTPS with a certificate the device trusts. For a small single box such as a Raspberry Pi, Jellyfin is the lighter choice.

## What works

- Movies and series, with direct play, remux or transcode chosen per client. Hardware transcoding on NVIDIA, Intel Quick Sync and VA-API.
- Music with an OpenSubsonic API, mixes and sound-alike discovery. Discovery runs on a local sonic sidecar (x86-64 only, off by default) and needs no external key. A provider key (OpenAI or Voyage AI) is only for recommendations, lyrics search and the AI assistant.
- Audiobooks, read from your Audiobookshelf server.
- Live TV from HDHomeRun, M3U and Xtream sources, with a programme guide. It is off by default and needs the stream-proxy container and a shared secret.
- Native apps for iPhone, iPad and Apple TV, with offline downloads on iPhone and iPad. They are closed source and free, through public TestFlight only.
- A web app in English and German.

## Not included

- No DVR. Live TV is for watching.
- No Android or Windows app. Use a Jellyfin app on those.
- Audiobooks need an Audiobookshelf server. Lumastra does not scan audiobook files itself.
- On arm64 there is no music BPM and mood analysis, no sonic sidecar, and no Quick Sync or VA-API.

## Quick start

Docker Compose:

```bash
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Sapd/lumastra/main/docker-compose.example.yml
curl -fsSL -o .env https://raw.githubusercontent.com/Sapd/lumastra/main/.env.example
# in .env, set DATABASE_PASSWORD and CACHE_PASSWORD (openssl rand -hex 24)
# mount your media folder on both the lumastra and lumastra-worker services
docker compose up -d
```

Only the two passwords are required. Lumastra generates its master key into `/config/master.key`. Open `http://localhost:3000` and follow the setup wizard. That port listens on the host only; put a reverse proxy in front for other devices.

Back up the database, the `/config` volume and the master key if you set one yourself. Without the key, stored secrets are gone. Details: [install guide](https://lumastra.org/start/quick-start/).

Kubernetes: there is a Helm chart in `deploy/helm/lumastra`. See the [Kubernetes guide](https://lumastra.org/guides/deploy-kubernetes/).

Platform notes: [known limitations](https://lumastra.org/reference/known-limitations/).

## Support

Bugs go to [GitHub issues](https://github.com/Sapd/lumastra/issues). Include the version, the logs and the steps to reproduce. Security issues go through a private advisory, see [SECURITY.md](.github/SECURITY.md). Questions and ideas go to [Discussions](https://github.com/Sapd/lumastra/discussions) or [Discord](https://discord.gg/ZhaFYkuqq9).

## Licence

AGPL-3.0-only, including `/j` and the AI assistant. No paid parts, no licence keys. The plugin SDK and the sample plugins are Apache-2.0. See [LICENSING.md](LICENSING.md).

The Lumastra name and logo are not covered by the licence. Forks must use their own name, see [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

Small fixes and bug reports are welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md). Running it from source: [development guide](docs/dev/DEVELOPMENT.md).

Like Lumastra? [Sponsor it on GitHub](https://github.com/sponsors/Sapd).
