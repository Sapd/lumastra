# Contributing

Bug reports and small fixes are welcome. For larger changes, open a Discussion first. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting a bug

Use the issue form. Include:

- the version and how you run Lumastra: Compose, Helm or something else
- the steps to reproduce, from a fresh page load
- the debug report: Admin → System → Debug report → Copy report.
- for playback problems, the matching incident under Admin → Users → Client diagnostics, and the entry under Admin → System → Transcode failures if the file was transcoded

Reports without logs or steps are marked needs-info and closed if nobody answers for a few weeks. Do not post anything that points to pirated media, and redact paths in logs. For security problems, do not open an issue; follow [SECURITY.md](SECURITY.md).

## Pull requests

Fork the repository, branch from `main` and open a pull request. Keep it to one change. Fixes, tests and documentation corrections can go straight to a pull request. Features, changes to behaviour people rely on, and anything in authentication, playback, the task system or migrations should start as a [Discussion](https://github.com/Sapd/lumastra/discussions/categories/features), so we can agree on the approach before you write code.

Before you open the pull request:

- Run the change on a real instance and watch it work. Say in the pull request what you did.
- Run the checks below and add a test for new behaviour.
- New files need an `SPDX-License-Identifier: AGPL-3.0-only` header. CI checks it.

The web app ships in English and German only.

### AI tools

AI tools are fine. Say so in the PR and be able to explain what you changed. Bug reports need a reproduction you ran yourself.

### The CLA

You accept the [CLA](CLA.md) once. The CLA Assistant bot asks on your first pull request. You keep your copyright and give the project owner a broad licence, including the right to license your contribution under other terms. The CLA also promises that merged contributions stay available in the public repository under AGPL-3.0 or another OSI-approved licence.

Why there is a CLA: I am the sole maintainer, the Apple apps are closed source, and I want to keep my options open, which includes licensing future versions differently. Every version already published under AGPL-3.0 stays available under AGPL-3.0, and anyone can fork it. The CLA cannot take that back.

## Running it locally

Full setup, including the `.env` values: [docs/dev/DEVELOPMENT.md](../docs/dev/DEVELOPMENT.md). In short:

```bash
docker compose -f docker-compose.dev.yml up -d
npm install && npm run dev        # http://localhost:5173
```

Checks (run `lint` on its own, it uses a lot of memory):

```bash
npm run lint && npm run typecheck && npm run check:svelte-types && npm test
```

`npm run typecheck` skips `.svelte` files; `npm run check:svelte-types` covers them. Integration tests: `npm run db:test:create && npm run db:test:migrate && npm run test:integration`.

Code style: Prettier, ESLint with zero warnings, Svelte 5 runes. [AGENTS.md](../AGENTS.md) lists the traps.
