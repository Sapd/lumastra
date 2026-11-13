# Contributing to Lumastra

Thanks for your interest in contributing! This guide covers how to set up a development
environment, run the tests, follow the project's code style, and submit changes.

By participating you agree to abide by our [Code of Conduct](https://github.com/Sapd/lumastra/blob/main/.github/CODE_OF_CONDUCT.md).

## Prerequisites

- **Node.js 22+** (the runtime image ships Node 24 LTS, see `.nvmrc`; CI tests on Node 22)
- **PostgreSQL** with the **pgvector** extension
- **Valkey** (or Redis) for caching and the task queue
- A CPU with x86-64-v2 support (SSE4.2, POPCNT), required by the `sharp` image library

The quickest way to get the supporting services is Docker; see the Docker Compose example in
[`README.md`](https://github.com/Sapd/lumastra/blob/main/README.md).

## Getting started

```bash
git clone <your-fork-url>
cd lumastra
npm install

# Copy the example environment and edit it for your setup
cp .env.example .env

# Start the dev server (http://localhost:5173)
npm run dev
```

For local development without a reverse proxy in front of the app: under `npm run dev`, a
request without forward-auth headers is signed in as `DEFAULT_USER` (default `admin`) with
admin rights. Set `LUMASTRA_DEV_NO_DEFAULT_USER=true` to sign in normally instead. See
[the configuration guide](https://lumastra.org/guides/configuration/) for the full
configuration reference, and [`docs/dev/QUICK-START.md`](https://github.com/Sapd/lumastra/blob/main/docs/dev/QUICK-START.md) for more
development commands.

## Running tests

```bash
# Unit + component tests (fast, mocked dependencies)
npm test

# Integration tests (require a PostgreSQL "lumastra_tests" database)
npm run db:test:create
npm run db:test:migrate
npm run test:integration

# End-to-end tests (Playwright; auto-starts a dev server)
npm run test:e2e          # full suite
npm run test:e2e:api      # API tests only
```

Integration tests live next to the code they cover as `*.integration.test.ts` and run
against a real database. See [`docs/dev/QUICK-START.md`](https://github.com/Sapd/lumastra/blob/main/docs/dev/QUICK-START.md) for details
on configuring `TEST_DATABASE_URL`, and for which checks must be green before a PR (lint,
typecheck and the unit suite; CI runs the integration and end-to-end tiers as well).

## Code style & quality

- **Formatting:** Prettier, 4-space indent, single quotes, trailing commas, 100-column width (see `.prettierrc`).
  Run `npm run format`. Prettier also runs automatically on commit.
- **Linting:** ESLint with a **zero-warnings policy** (`--max-warnings=0`).
  Run `npm run lint` (or `npm run lint -- --fix`). Document any rule exception in
  [`docs/dev/eslint-exceptions.md`](https://github.com/Sapd/lumastra/blob/main/docs/dev/eslint-exceptions.md).
- **Type checking:** two commands, and you need both, since they cover different files.
  `npm run typecheck` (tsgo) covers `.ts`; `npm run check:svelte-types` covers `.svelte`.
  `npm run check` is a fast structural pass only. It does **not** type-check components,
  so a real type error inside a `.svelte` file passes it silently. Avoid `any`, prefer
  `unknown` with type guards. Give functions explicit return types.
- **Svelte:** this project uses Svelte 5 (runes). Use the Svelte MCP server / official Svelte 5
  docs for component work.
- **Conventions:** many directories contain a `CLAUDE.md` with module-specific guidance. Read
  it before changing code in that area. The big-picture rules live in
  [`AGENTS.md`](https://github.com/Sapd/lumastra/blob/main/AGENTS.md) and
  [`docs/dev/DEVELOPER-GUIDE.md`](https://github.com/Sapd/lumastra/blob/main/docs/dev/DEVELOPER-GUIDE.md).

Before opening a PR, please run:

```bash
npm run lint && npm run typecheck && npm run check:svelte-types && npm test
```

> Tip: `npm run lint` is memory-hungry, run a single instance at a time.
>
> `npm run check:svelte-types` takes about 90s. It is the only command that type-checks
> `.svelte` files, and it is a blocking CI job, so run it before pushing component
> changes rather than discovering the failure in CI.

## Before you start

Not every change needs a conversation first, but some do, and the rules are about review
capacity, not gatekeeping.

**Welcome without prior discussion:** bug fixes, small improvements, typo and copy fixes,
test coverage, documentation. Open the PR; if it is focused and verified it
will be reviewed as-is.

**Needs an accepted discussion first:** anything that adds a feature, changes behaviour
users rely on, touches several subsystems, or would land as `size:L`/`size:XL`. Propose it
in [Discussions → Features](https://github.com/Sapd/lumastra/discussions/categories/features)
and wait for a maintainer to accept it. They will open the tracking issue. **Feature PRs
without an accepted discussion are closed unread**, however good the code. The design
conversation has to happen before the implementation, not in review.

**Larger changes are for experienced developers.** Small fixes are welcome from anyone.
For a feature, a large change, or a change in a complicated area (authentication and access
control, playback and transcoding, the task system, database migrations, the license
boundary) we assume the author has hands-on software development experience: you will be asked about design decisions, edge cases and failure modes in
review, and "the tool wrote it that way" is not an answer. If you are early in your
development journey, start with the smaller category. Those PRs are just as valued, and
they build the track record.

**AI assistance is fine, disclosed.** See [AI-assisted contributions](#ai-assisted-contributions) below. Two rules have no exceptions: every change, AI-assisted or not, must be tested end to end on a running instance, and every PR gets an AI code review before merge (see [CONTRIBUTING-AI.md](https://github.com/Sapd/lumastra/blob/main/.github/CONTRIBUTING-AI.md)). "Vibe-coded" PRs, meaning not fully tested, or code the author can't explain, are not accepted. Opening PRs just for the sake of it, or submitting someone else's code, translations or other work as your own, gets you banned without warning.

## Translations

The web app ships in English and German. Other languages aren't accepted for now: about
10,000 strings still change with almost every release before 1.0, and every language has to
keep up with them. Pull requests that add or update other languages are closed with a pointer
to the [Translations discussion](https://github.com/Sapd/lumastra/discussions/categories/general).
Comment there with the language you would translate, so we know where the interest is. When
translations open up, they will run through a separate translation repository or platform,
not through pull requests to this repository.

Fixes to the existing English or German text are welcome as normal PRs.

**Trivial changes** (a single typo, whitespace, small wording fixes) may be applied by a
maintainer directly, with thanks in the PR, instead of being merged as they are.

## Submitting changes

1. Fork the repo and create a feature branch from `main`.
2. Make focused commits with short, imperative, sentence-cased messages
   (e.g. "Fix player back-button behavior").
3. Keep each source file's `SPDX-License-Identifier` header intact. New files use
   `AGPL-3.0-only` (see [Licensing](#licensing-of-contributions)).
4. Ensure lint, type-check, and tests pass. Add tests for new behavior; add E2E coverage when
   changing user-facing behavior.
5. Open a pull request using the template: what it does, the prior discussion (for features),
   how you verified it, and the AI-assistance disclosure. Include screenshots for UI changes.
   Every PR is auto-labelled with its size (`size:XS` … `size:XL`); an XL PR that references
   no accepted discussion will be asked to split or to get one.

## AI-assisted contributions

Lumastra itself is built with heavy AI assistance, so this project will never tell you not
to use AI. It asks three things instead:

1. **Disclose it, always.** The PR template has a required _AI assistance_ section: tick the
   extent (**none** / **autocomplete and lookups only** / **parts**, saying which / **most of
   it**) and name the **tools and models** used, e.g. "Claude Code (Claude Sonnet 5)" or
   "Cursor (GPT-5)". PRs disclosing _parts_ or _most_ get an `ai-assisted` label
   automatically so the disclosure stays visible in the PR list. Disclosure has no effect on
   how the PR is judged, the bar is the same, but discovering undisclosed substantial AI
   generation in review is treated like any other misrepresentation, and the PR is closed.
2. **You are the author.** Whatever produced the first draft, you must have run it on a
   real instance, understood it, and be able to explain any line when asked. "The tool wrote
   it that way" is never an answer in review. This is also why larger changes are reviewed
   on the assumption of hands-on development experience (see _Before you start_).
3. **No unverified AI output, anywhere.** Bug reports must contain a reproduction you
   performed yourself; security reports need a working proof-of-concept you validated; PRs
   must compile, pass the gates and have been exercised. Raw model output, AI-relayed review
   replies and drive-by "AI cleanup" sweeps are closed, and repeat offenders are banned.

Provenance still applies: if a model reproduces recognisable third-party code, treat it
the same way as code you copied by hand: check the license, attribute it, or leave it out. The
[CLA](https://github.com/Sapd/lumastra/blob/main/.github/CLA.md) you sign warrants the contribution is yours to give. The full policy, including
guidance for autonomous agents, is in [`CONTRIBUTING-AI.md`](https://github.com/Sapd/lumastra/blob/main/.github/CONTRIBUTING-AI.md).

## Reporting bugs

Use the issue forms; they ask for what a maintainer needs on the first pass:

- **Bug report** for anything broken. Attach the **diagnostics export** (Admin → System →
  Diagnostics → Export Diagnostics → _Copy for GitHub_): version, platform, flags and recent
  errors in one paste.
- **Playback / streaming problem** for anything that fails to play, stalls, or transcodes
  badly. Besides the diagnostics export it asks for the **playback incidents** rows
  (Admin → Users → Playback incidents) and, when transcoding is involved, the entry from
  **Admin → System → Transcode failures**. Those three are what let us see what your server saw.
- **Documentation issue** for wrong or missing docs in this repository. The lumastra.org
  docs live in [Sapd/lumastra-docs](https://github.com/Sapd/lumastra-docs): open issues and
  pull requests for them there.

Every space here has one hard content rule: **nothing that references pirated content**, not even indirectly, so no release-group tags, indexers, or revealing filenames in logs. Redact before posting; see the [content rules](https://github.com/Sapd/lumastra/blob/main/.github/CODE_OF_CONDUCT.md#content-rules).

Search existing issues and discussions first, and report only what you reproduced yourself.
AI-generated reports without a human reproduction are closed (see
[`CONTRIBUTING-AI.md`](https://github.com/Sapd/lumastra/blob/main/.github/CONTRIBUTING-AI.md)).

## Requesting features

**Not through issues.** Feature requests belong in
[Discussions → Features](https://github.com/Sapd/lumastra/discussions/categories/features), where
they can be shaped, weighed against the roadmap and, if accepted, turned into a tracking issue
by a maintainer. Questions and "how do I" belong in
[Q&A](https://github.com/Sapd/lumastra/discussions/categories/q-a). Issues filed as feature
requests are converted or closed with a pointer here.

Search before posting: if the idea is already there, **upvote it** (the ▲ next to the title) and
add your use case as a comment. Upvotes are the signal we use to prioritise; sorting the
Features category by **Top** shows the most-wanted requests.

For **security vulnerabilities**, do **not** open a public issue. Follow
[`SECURITY.md`](https://github.com/Sapd/lumastra/blob/main/.github/SECURITY.md).

## Licensing of contributions

Lumastra is licensed under the **AGPL-3.0-only** (see
[`LICENSING.md`](https://github.com/Sapd/lumastra/blob/main/LICENSING.md)). The plugin SDK and
sample plugins are Apache-2.0.

Contributions are accepted under the project's [Contributor License Agreement (CLA)](https://github.com/Sapd/lumastra/blob/main/.github/CLA.md).
You keep copyright in your work and grant the rights the CLA describes. Kubernetes, the Apache
Software Foundation projects, Python and Go also ask contributors to sign a CLA.

What the CLA does **not** change: contributions stay available under the AGPL (or another
OSI-approved open-source license; the CLA promises this), and anyone can fork the project at any
time. By submitting a contribution you agree to the CLA; the CLA Assistant bot records your
agreement on your first PR (reply to its comment with the sentence it asks for, once per GitHub
account, never again; the same record covers every Lumastra repository, including the docs). The
bot stores only your GitHub username and user id, the repository and PR number, the id of your
signing comment and a timestamp; see the CLA's GDPR notice (§11) for controller, retention and
your rights.

A few practical points:

- Commit with an e-mail address that is linked to your GitHub account. Otherwise the bot can't
  match the commit to you and blocks the PR.
- Every commit author of a PR needs to sign (the bot checks each one). For a co-author who can't,
  confirm in the PR that they authorized you to submit their work (CLA §5).
- Third-party code or assets in a PR must be named with their source and license, and that
  license has to allow both the AGPL and commercial distribution (MIT, BSD, ISC, Apache-2.0 and
  similar). GPL, AGPL, LGPL, CC BY-SA and "non-commercial" material can't be accepted. See CLA §5.
- New files need the tier's `SPDX-License-Identifier` header (see above) and may carry your own
  `SPDX-FileCopyrightText` line; you keep your copyright.
- Contributing for a company? The individual CLA covers it if you are authorized to sign for
  the company (CLA §4). If your company wants a countersigned agreement, write to
  <git@sapd.eu>.

Thank you for contributing! 🎬
