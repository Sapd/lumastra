<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# CI change detection

A pull request runs only the heavy CI jobs its changed files can affect. Pushes to `main`, tags and
manual runs always run everything. When in doubt, a job runs: a file nobody has classified runs every job.

## How it works

`.github/workflows/changes.yml` is a reusable workflow. `lint.yml`, `typecheck.yml`, `test.yml` and
`jellyfin-contract.yml` each start with a `changes` job that calls it. It checks out the merge commit
of base and head, diffs it against its first parent (`git diff --name-status --no-renames`), and
`scripts/ci/changed-jobs.mjs` turns the file list into one boolean per job. The heavy jobs `need` it
and use a job-level `if:`. A job skipped by `if:` reports success to required checks; a workflow
skipped by `on.pull_request.paths` reports nothing and would leave a required check pending forever.

Safeguards:

- Only `pull_request` events select. Any other event selects every job.
- If the change set cannot be read (no merge commit, git error, empty diff), every job runs.
- If the `changes` job itself fails, the jobs run anyway (`needs.changes.result != 'success'` is part of every `if:`).
- `GLOBAL` paths run everything and beat every ignore pattern.
- A job is skipped only when EVERY changed file is on that job's ignore list.
- A matrix job skipped by `if:` reports under its unexpanded name, so `test.yml` has a `Tests (gate)`
  job that always runs and fails if any suite that ran failed. Require that check, not the per-shard names.

The step summary of the `Select jobs` job lists each job and the files that made it run.

## Rules

The source of truth is `scripts/ci/changed-jobs.mjs`; `scripts/ci/changed-jobs.test.js` pins every row below.

**Run everything (GLOBAL):** `package.json`, `package-lock.json`, `packages/**/package.json`, `.npmrc`,
`.nvmrc`, `.node-version`, `.node-min-version`, `.tool-versions`, `tsconfig*.json`, `tsconfig/*.json`, `vite*.ts`,
`vitest*.ts`, `tests/vitest/*.ts`, `svelte.config.*`, `eslint.config.*`, `tailwind.config.*`, `postcss.config.*`,
`project.inlang/**`, `.github/workflows/**`, `.github/actions/**`, `scripts/ci/**`, `docs/api/**`
(the OpenAPI spec generates `src/lib/api/schema.d.ts`, and tests read the guide).

**Inert (skips every selected job):** `docs/**` (except `docs/api/**` and the two read-by-tests paths
below), root `CHANGELOG.md` `README.md` `AGENTS.md` `CLAUDE.md` `TRADEMARKS.md` `LICENSE`, nested
`README.md`/`CLAUDE.md`/`AGENTS.md` under `scripts src tests native deploy workers`, GitHub community
files (`.github/*.md`, issue templates, `CODEOWNERS`, `FUNDING.yml`, `dependabot.yml`, label and
release config), `.vscode/**`, `.editorconfig`. Markdown in general is NOT inert: tests read
`plugins/lumastra-skills/**` and `docs/api/**`.

**Read by tests:** `docs/architecture/user-events.md` (`event-kinds.test.ts`) and `docs/examples/**`
(`deployment-topology.test.mjs`). They run the unit and other-suites jobs, nothing else.

| Job (workflow)                                     | What it runs                                                                                                              | Besides the inert paths, a change to these does NOT run it                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ESLint (`lint.yml`)                                | tier check, callback-safety rule tests, fast + type-aware ESLint, SPDX header check, operator-copy check, action-pin guard  `native/**`, `workers/**`, `deploy/**`, `Dockerfile`, `.dockerignore`, `docker-compose*.yml`, `static/**`, `**/*.css`, the two read-by-tests docs                                                                                                                                                         | ESLint reads `src`, `scripts`, `tests`; `messages/**` stay a trigger because the typed pass resolves paraglide and `lint:copy` reads the message files                                                      |
| Typecheck (`typecheck.yml`)                        | tsgo, sandbox bundle guard, rule self-tests                                                                               | same as ESLint, plus a MODIFIED `**/*.svelte`                                                                                                                                                                                                                                                             | tsgo skips `.svelte` on purpose. Adding, deleting or renaming a component still runs it: the route list feeds the generated `$app/types`. `messages/**` stay a trigger: paraglide generates typed functions |
| Svelte component types (`lint.yml`)                | svelte-check                                                                                                              | same as ESLint                                                                                                                                                                                                                                                                                            | Components are checked against the TS they import. Still on demand only (`workflow_dispatch`); the selection output `svelte_types` is wired for when it is automatic again                                  |
| Unit tests, 8 shards (`test.yml`)                  | unit suite                                                                                                                | inert paths only                                                                                                                                                                                                                                                                                          | The suite also scans the tree: 40 tests read `.svelte` as text, others read `deploy/`, `native/`, `workers/` scripts, docs and `.env.example`                                                               |
| Component, stream-proxy, plugin SDK (`test.yml`)   | component suite, Rust Live TV proxy build + conformance, SDK suites                                                       | `workers/**`, `deploy/**`, container files, `native/watcher/**`, `native/task-queue/**`                                                                                                                                                                                                                   | Only `native/livetv-proxy` is built here                                                                                                                                                                    |
| Integration tests, 4 shards (`test.yml`)           | PostgreSQL/Valkey suite                                                                                                   | all of `docs/**`, `workers/**`, `deploy/**`, container files, `native/watcher/**`, `native/task-queue/**`, `**/*.svelte`, `**/*.css`, unit tests (`*.test.*` that are not `*.integration.test.*` / `*-integration.test.*`), Playwright specs (`*.spec.ts`)                                                | No integration test and no server module imports a `.svelte` or `.css` file, and no file imports a test file. `static/**` and `messages/**` still run it (served files, server-side strings)                |
| Jellyfin client contract (`jellyfin-contract.yml`) | contract validator + Kotlin SDK decode                                                                                    | runs ONLY for: GLOBAL, `src/routes/(proprietary)/j/**`, `src/lib/server/proprietary/jellyfin-compat/**`, the media-stream and external-subtitle mappers and queries, `jellyfin-response-observer.ts`, `tests/jellyfin-contract/**`, `src/lib/server/database/migrations/**`, `tests/integration/setup/**` | A positive list (the old `paths:` list plus migrations, which the job runs). No push trigger yet (30 min, capped minutes while private)                                                                     |
| Secret scan                                        | always                                                                                                                    | never skipped                                                                                                                                                                                                                                                                                             | Cheap, and it guards the whole history                                                                                                                                                                      |
| Docker image (`docker-publish.yml`)                | image build                                                                                                               | unchanged: keeps its own `on.pull_request.paths`                                                                                                                                                                                                                                                          | Not a required check; its list mirrors what the Dockerfiles COPY                                                                                                                                            |
| E2E (`e2e.yml`)                                    | Playwright                                                                                                                | unchanged: runs on the `run-e2e` label                                                                                                                                                                                                                                                                    |                                                                                                                                                                                                             |

What a typical pull request runs:

| Change                                      | Runs                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| docs only                                   | Secret scan                                                          |
| edit a `.svelte` file                       | ESLint, unit, components + proxy + SDK                               |
| add or delete a `.svelte` file              | the same plus Typecheck                                              |
| server code (service, query, route handler) | ESLint, Typecheck, unit, components + proxy + SDK, integration       |
| translations (`messages/**`)                | the same (typed functions, copy check, parity tests, server strings) |
| `/j` code or a migration                    | everything including the Jellyfin contract                           |
| lockfile, config, workflow                  | everything                                                           |

## What was deliberately not skipped

- A changed unit test still runs the unit suite and the others: guard tests scan test files too.
- An integration test change still runs the unit suite for the same reason.
- `messages/**` runs everything but the Jellyfin job. Telling a harmless value edit from a renamed key
  or a changed `{param}` needs a parse of both files; not worth the risk yet.
- Import-graph selection (`vitest related`) is not used: a typical service file selects about 70 % of the suite.
- `static/**` runs unit, components and integration: service-worker and served-asset tests may read it.

## Caches

- **ESLint, pull requests only.** `.eslintcache-fast` and `.eslintcache-typed` are restored and saved with
  `actions/cache/restore` and `/save`, and ESLint runs with `--cache-strategy content` (the default
  compares modification times, which a fresh checkout resets). The keys hash the lockfile, `package.json`,
  `eslint.config.cjs`, `tsconfig*.json` and `scripts/eslint-plugin-callback-safety/**` (ESLint does not
  hash plugin code); the typed key also hashes `docs/api/openapi.yaml`, `messages/*.json` and
  `project.inlang/**`. The key ends in the run id so every run saves; `restore-keys` restores the newest.
  Pushes to `main` run uncached.
  Known limit: a typed result for a file can go stale inside one pull request when a file it imports
  changes its types. The push to `main` re-lints everything uncached and is the backstop.
- **`node_modules`:** not cached. `setup-node` with `cache: npm` already caches the npm download cache, and
  restoring `node_modules` would skip the install scripts.
- **Generated files** (paraglide, OpenAPI types, `svelte-kit sync`, task runtime): not cached. Each takes
  seconds; a stale copy would hide a real break, and the exact inputs span too many files to key safely.
- **Cargo** (`target/` of the Live TV proxy): not cached yet. Candidate keyed on `Cargo.lock` + `native/livetv-proxy/**`.

## Changing the rules

Edit `scripts/ci/changed-jobs.mjs`, add or adjust a row in `scripts/ci/changed-jobs.test.js`, and run
`npx vitest run scripts/ci/changed-jobs.test.js`. Prefer making a rule narrower over wider. A new
kind of file needs no entry: unlisted files run everything.
To try it on a real range:

```bash
git diff --name-status --no-renames origin/main~20..origin/main \
  | node scripts/ci/changed-jobs.mjs --stdin --event pull_request
```
