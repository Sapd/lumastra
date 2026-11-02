# Quick Start Guide

Get up and running with Lumastra **development**. Installing and operating a server is
documented on the website — start at
[lumastra.org/developers/local-development](https://lumastra.org/developers/local-development/)
for the infrastructure setup (PostgreSQL + two Valkeys via `docker-compose.dev.yml`, `.env`,
the dev auth bypass) and come back here for the commands.

**Quick Links:**

- 📖 [Main Project Guide](../../CLAUDE.md) - Core architecture and critical rules
- 📘 [Developer Guide](./DEVELOPER-GUIDE.md) - Comprehensive API references and patterns
- 🌐 [Environment variables](https://lumastra.org/reference/environment-variables/) - every setting, on the website

## Table of Contents

- [Development Commands](#development-commands)
- [Project Setup](#project-setup)
- [Testing](#testing)
- [Building](#building)
- [Versioning & Releases](#versioning--releases)
- [Development Tips](#development-tips)
- [Troubleshooting](#troubleshooting)

---

## Development Commands

### Development Server

```bash
# Start the web development server
npm run dev

# In a second terminal, start exactly one lean task worker
npm run dev:worker

# Start with specific port
PORT=3000 npm run dev

# Start with debug logging
DEBUG=* npm run dev
```

`npm run dev` serves web requests and submits tasks. `npm run dev:worker` builds
and starts the lean TypeScript task worker with a supervised Rust watcher child.
It reuses `build/lumastra-watcher` when it is newer than every file under
`native/watcher/src`, `Cargo.toml` and `Cargo.lock`; otherwise it runs
`npm run build:watcher`. The build uses the pinned Rust toolchain in
`native/rust-toolchain.toml` and installs the release binary at
`build/lumastra-watcher`. Install that toolchain before starting the worker.
Keep exactly one worker. Rust is the only watcher in development and production;
`LUMASTRA_WATCHER_BINARY` overrides the executable path.

To rebuild the watcher independently (also required after an app build clears `build/`):

```bash
npm run build:watcher
```

### Code Quality

```bash
# Type checking — .ts files (tsgo)
npm run typecheck

# Type checking — .svelte components (~90s, blocking in CI).
# Nothing else type-checks components: `npm run check` is a fast
# structural pass that reports zero errors for .svelte.
npm run check:svelte-types

# Type checking with watch mode (.svelte)
npm run check:watch

# Linting
npm run lint

# Auto-fix linting issues
npm run lint -- --fix

# Code formatting
npm run format

# Format specific files
npm run format -- src/lib/**/*.ts
```

### Database Operations

```bash
# Run database migrations
npm run startup-migration

# Sync TMDB metadata
npm run sync-metadata

# Heal phantom media_files rows (paths missing on disk).
# Dry run by default; pass --apply to actually delete.
# Walks every row and routes missing-on-disk files through deleteStaleMediaFile
# so sibling promotion + has_files recompute run atomically.
npm run heal:phantom-files            # dry-run summary
npm run heal:phantom-files -- --apply # actually delete the missing rows
```

### Configuration validation (doctor)

Validates environment configuration that would otherwise fail silently or only
at first use — most importantly that `EMBEDDING_DIMENSIONS` matches the
embedding model (a mismatch makes the AI assistant 500 and silently writes no
library embeddings). Exits non-zero if any error is found, so it's safe to run
in CI or a pre-deploy check.

```bash
# Local checkout
npm run doctor

# Docker — no repo clone needed; the script ships in the image
docker exec <container> npm run doctor
```

> These checks also run automatically at container boot (STEP 0 of the startup
> migration), so a misconfiguration is visible in `docker logs` without running
> anything manually. A configuration **error** fails boot loudly; set
> `LUMASTRA_SKIP_PREFLIGHT=true` to bypass.

---

## Project Setup

### Prerequisites

- **Node.js** 22+ (`.nvmrc` pins local development; `Dockerfile` pins container Node)
- **PostgreSQL** 17+ with the pgvector extension
- **Valkey** (or Redis)

Nothing else is required. Jellyfin, Audiobookshelf and the other integrations are
optional and can be added later from the admin UI.

### Initial Setup

```bash
git clone https://github.com/Sapd/lumastra.git
cd lumastra
npm install

# Infrastructure: PostgreSQL + two Valkeys for local development
cp .env.example .env               # set POSTGRES_PASSWORD and CACHE_PASSWORD at minimum
docker compose -f docker-compose.dev.yml up -d

npm run startup-migration          # creates the schema (pgvector is enabled by the image)
npm run dev                        # web: http://localhost:5173
# In a second terminal:
npm run dev:worker                 # task host + Rust watcher
```

The website's [local development](https://lumastra.org/developers/local-development/)
page walks through the same steps with the dev auth bypass and the variables that
matter for a first run.

### Development Workflow

1. **Make changes** - Edit files in `src/`
2. **Check types** - Run `npm run typecheck` frequently; `npm run check:svelte-types` before pushing component changes
3. **Run tests** - Ensure tests pass before committing
4. **Lint** - Run `npm run lint` before committing
5. **Commit** - Use conventional commits (e.g., `feat:`, `fix:`, `refactor:`)

---

## Testing

### Three-Tier Strategy

#### Unit Tests

**Fast tests with mocked dependencies**

```bash
# Run all unit tests
npm test

# Watch mode
npm test -- --watch

# Specific test file
npm test -- src/lib/utils/data-extraction.test.ts

# With coverage
npm test -- --coverage
```

**When to use:**

- Testing utility functions
- Testing transformations
- Testing business logic without I/O

#### Integration Tests

**Real database tests**

```bash
# One-time: a dedicated test database
npm run db:test:create
npm run db:test:migrate

# Run integration tests
npm run test:integration

# Specific integration test
npm run test:integration -- media-lookup.queries.integration.test.ts
```

**Requirements:**

- Running PostgreSQL database
- `TEST_DATABASE_URL` pointing at the `lumastra_tests` database (defaults to
  `localhost:5432`; override to target another host)

**When to use:**

- Testing database queries
- Testing services with real data
- Testing data transformations with real schemas

**Live-server cases inside the integration suite**

A few files talk to a real external server and skip themselves (printing the
reason to stderr) when it is not reachable. They are part of
`npm run test:integration`, not a separate command:

| File                                       | Needs                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `audiobook-remux.live.integration.test.ts` | `AUDIOURL` + `AUDIOAPIKEY`, and an audiobook with a persisted `eac3` codec in the app's database |

The E-AC-3 book is **discovered** from `custom_metadata.audiobookshelf.audioFiles`
— no fixture id to keep up to date. Overrides, all optional:

- `AUDIOBOOK_REMUX_TEST_ITEM_ID` — pin the AudiobookShelf item instead of discovering one
- `AUDIOBOOK_REMUX_TEST_INO` — pin the file within it (default: the longest E-AC-3 file)
- `AUDIOBOOK_REMUX_TEST_DATABASE_URL` — where to run the discovery query. Defaults to
  `DATABASE_URL` **as written in `.env`**, because the integration harness rewrites
  `process.env.DATABASE_URL` to the fixtures database, which has no real library in it.

#### E2E Tests

**Full HTTP flow tests** (Playwright; the config auto-starts a dev server)

```bash
# API-level specs only
npm run test:e2e:api

# Everything, including browser UI specs
npm run test:e2e

# A single spec
npm run test:e2e:api -- tests/streaming-sessions.api.spec.ts
```

**Requirements:**

- Running database with migrations applied
- Configured environment variables

**When to use:**

- Testing API endpoints end-to-end
- Testing authentication flows
- Testing multi-step workflows

### What must be green

`npm run lint`, `npm run typecheck` and `npm test` are the gates every change has to
pass; CI runs the integration and end-to-end tiers as well. If a failure there looks
unrelated to your change, check whether it also fails on `main` before digging.

### Test Configuration

**Unit tests:** `vitest.config.ts` (components: `vitest.config.components.ts`)
**Integration tests:** `vitest.integration.config.ts`
**E2E tests:** `playwright.config.ts`

### Writing Tests

**Unit test example:**

```typescript
import { describe, it, expect } from 'vitest';
import { toNumberOr } from '$lib/utils/data-extraction';

describe('toNumberOr', () => {
    it('should return number when valid', () => {
        expect(toNumberOr('42', 0)).toBe(42);
        expect(toNumberOr(42, 0)).toBe(42);
    });

    it('should return default when invalid', () => {
        expect(toNumberOr('invalid', 10)).toBe(10);
        expect(toNumberOr(null, 10)).toBe(10);
    });
});
```

**Integration test example:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDatabase } from '$lib/server/database/test-helpers';
import { resolveTmdbToUuid } from '$lib/server/database/queries/media-lookup.queries';

describe('Media Lookup Integration', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await getTestDatabase();
    });

    afterAll(async () => {
        await sql.end();
    });

    it('should resolve TMDB ID to UUID', async () => {
        const uuid = await resolveTmdbToUuid(sql, 550, 'movie');
        expect(uuid).toBeDefined();
        expect(typeof uuid).toBe('string');
    });
});
```

---

## Building

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

**Build output:** `build/` directory (Node.js adapter, `@sveltejs/adapter-node`). The
service-worker version auto-increments on build; the plugin-isolation worker bundle is
built last (`npm run build:sandbox`) and refuses any import that would not survive
`npm prune --production`.

The container image is built from the root `Dockerfile`; its entrypoints live in
`deploy/docker/` and are copied to `/app` in the image. Deploying the result is covered on the
website under [Deployment](https://lumastra.org/guides/deployment/).

Container Node comes from the official Node image. All Node stages use the same patch
version, each pinned to its variant's multi-architecture index digest. `.node-min-version` is the minimum
allowed container version; the runtime build prints `node --version` and fails below that
floor. Dependabot checks the Docker pins daily and groups Node updates. When accepting an
update, keep every Node stage on the same release and raise `.node-min-version` for security
fixes. Verify index digests (not per-platform manifests) with
`docker buildx imagetools inspect node:<version>-<variant>`.

After changing these pins, build and smoke-test both `linux/amd64` and `linux/arm64`:

- Check `node --version` against the pin, plus `npm --version`, `npx --version` and
  `corepack --version` as the image's `node` user.
- Boot the web and worker entrypoints against PostgreSQL and Valkey; migrations run via
  `node_modules/.bin/tsx`. Confirm `/api/health/ready` returns HTTP 200.
- Confirm the downloaded `/config/bin/ffmpeg -version` and `/config/bin/ffprobe -version`
  run, the worker starts `build/lumastra-watcher`, and `./start-proxy.sh` starts the Rust
  `build/lumastra-livetv-proxy --serve` process. Both native binaries must also answer
  `--version` without missing-library or architecture errors.
- Confirm `/usr/bin/tini -s --` remains PID 1 and graceful shutdown reaches Node.

---

## Versioning & Releases

The app version shown on the About page and **Admin → System → Instance** is derived
from **git tags** at build time — there is no manual version field to bump. CI computes
it with `git describe --tags --always --dirty --match "v*"` and passes it (plus the
commit SHA, build time, and branch) into the image as build-args:

- **On a tagged commit** → a clean release version, e.g. `v0.4.0` (this is an "official" build).
- **Off-tag** (any normal `main` build) → `v0.4.0-5-ge6f5150` — the last tag plus
  the commit count and short SHA, so every build is uniquely identifiable.
- **No git / tarball build** → falls back to `package.json` version, then `"unknown"` (never crashes).

**To cut a release, push a tag** (CI no longer auto-tags on every push):

```bash
git tag -a v0.4.0 -m "v0.4.0"
git push origin v0.4.0
```

The next build on that commit then reports the clean `v0.4.0`. Because `git describe`
anchors to the **nearest** ancestor tag, keep the tag namespace clean — the historical
`v1.1.*` auto-counter tags were pruned when this scheme was introduced; do not
reintroduce per-push tagging.

**Published images** (`.github/workflows/docker-publish.yml`, GitHub-hosted runners, built
from this repository's tree) go to `ghcr.io/lumastra/lumastra` and
`ghcr.io/lumastra/lumastra-sonic-embedder`:

| Trigger                | Tags                                   | Platforms               |
| ---------------------- | -------------------------------------- | ----------------------- |
| push to `main`         | `:edge`, `:sha-<short>`                | `linux/amd64`           |
| tag `vX.Y.Z`           | `:X.Y.Z`, `:X.Y`, `:stable`, `:latest` | `linux/amd64` + `arm64` |
| tag `vX.Y.Z-rc.1` etc. | `:X.Y.Z-rc.1` only                     | `linux/amd64` + `arm64` |
| pull request           | nothing pushed (build + checks only)   | `linux/amd64`           |

Release builds carry provenance and SBOM attestations. Before anything is pushed, the
workflow lists the built image's filesystem and fails if any path under `/app` looks like
the Enterprise tier (`scripts/check-image-enterprise-free.sh <image>` runs the same check
locally). The sidecar rebuilds on every release, and on `main` only when
`workers/sonic-embedder/` changed.

**`package.json`'s `version` is the tarball fallback only** — nothing else reads it
(`vite.config.ts` passes it to `deriveBuildInfo` as the last entry in the chain above,
below `APP_VERSION` and `git describe`, and `git describe --always` answers with a bare
SHA even in a tagless repo, so it is reached only in a git-less source build). It is
still worth keeping truthful, because that is exactly the build whose reporter has no
other way to say what they are running. **When you cut a release tag, move it to match**
— `v0.4.0` → `"version": "0.4.0"`, in the same commit as the tag, then
`npm install --package-lock-only` so the lockfile root agrees. It is a manifest fact,
not the release mechanism; the tag remains the release.

`config.buildInfo` (`{ version, commit, commitShort, buildTime, branch }`) is the single
source of truth at runtime; `config.APP_VERSION` is a string alias equal to
`buildInfo.version` and drives the cluster version-mismatch banner.

---

## Development Tips

### Hot Module Replacement (HMR)

Vite provides instant HMR for most changes. If HMR fails:

1. Check browser console for errors
2. Restart dev server
3. Clear browser cache

### Type Checking in IDE

**VS Code:** Install recommended extensions (`.vscode/extensions.json`)

**WebStorm/IntelliJ:** Enable TypeScript language service

### Database Inspection

```bash
# Connect to database
psql $DATABASE_URL

# Useful queries
\dt                          # List tables
\d media_items              # Describe table
SELECT COUNT(*) FROM media_items;
```

### Cache Inspection

```bash
# Connect to Valkey/Redis
redis-cli

# List keys
KEYS *

# Get cache value
GET v1:sessions:user123

# Clear cache
FLUSHDB
```

### Debugging

**Server-side:**

```typescript
import { logger } from '$lib/server/logger';

logger.debug('Processing item', { id, title });
logger.info('Operation completed', { count: 42 });
logger.error('Failed to fetch', { error });
```

**Client-side:**

```typescript
console.log('Data:', data);
console.table(items);
```

### Performance Profiling

**Database queries:**

```bash
# Enable query logging in PostgreSQL
ALTER DATABASE lumastra SET log_statement = 'all';

# Use EXPLAIN ANALYZE
EXPLAIN ANALYZE SELECT ...;
```

**Server response times:**

Check server logs for request duration:

```
[2024-01-30 12:34:56] INFO: GET /api/search?q=last%20signal 200 45ms
```

---

## Troubleshooting

### Common Issues

**Issue:** Port already in use

```bash
# Find process using port
lsof -ti:5173

# Kill process
kill -9 <PID>
```

**Issue:** Database connection failed

- Verify `DATABASE_URL` is correct
- Ensure PostgreSQL is running
- Check network connectivity
- Verify pgvector extension is installed

**Issue:** Build fails with type errors

```bash
# Clean and rebuild
rm -rf .svelte-kit node_modules
npm install
npm run typecheck && npm run check:svelte-types
```

**Issue:** Tests fail with "Cannot find module"

```bash
# Ensure all dependencies installed
npm install

# Clear test cache
npm run test -- --clearCache
```

---

## Additional Resources

- 📖 [Main Project Guide](../../CLAUDE.md) - Core architecture and critical rules
- 📘 [Developer Guide](./DEVELOPER-GUIDE.md) - API references and patterns
- 📁 [SvelteKit Documentation](https://kit.svelte.dev/docs)
- 📁 [Vitest Documentation](https://vitest.dev/)
- 📁 [Playwright Documentation](https://playwright.dev/)
