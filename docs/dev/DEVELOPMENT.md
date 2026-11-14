# Develop Lumastra

Run Lumastra from source on your machine. About 10 minutes.

You need:

- Node.js 22 or newer (`.nvmrc` pins 24)
- Docker with Compose
- Git
- FFmpeg, with `ffmpeg` and `ffprobe` on your `PATH`. Scans and playback fail without them.
- Rust, installed with [rustup](https://rustup.rs). The task worker builds a small Rust file watcher. The toolchain version is pinned in `native/rust-toolchain.toml`.

You do not need Jellyfin or any other media server.

## Run it

1. Clone and install. To send a pull request, fork the repo first and clone your fork.

    ```bash
    git clone https://github.com/Sapd/lumastra.git
    cd lumastra
    npm install
    ```

2. Write your `.env`. This sets random passwords and points the app at the local database and caches. The last two lines sign you in as `admin` without a password. They only work in `npm run dev`.

    ```bash
    cp .env.example .env
    PW=$(openssl rand -hex 24)
    cat >> .env <<EOF
    POSTGRES_PASSWORD=$PW
    CACHE_PASSWORD=$PW
    DATABASE_URL=postgresql://lumastra:$PW@localhost:5432/lumastra
    CACHE_URL=redis://default:$PW@localhost:6380/0
    TASK_CACHE_URL=redis://default:$PW@localhost:6379/0
    LUMASTRA_TRUST_ANY_PROXY=true
    DEFAULT_USER=admin
    EOF
    ```

3. Start PostgreSQL (with pgvector) and two Valkey servers.

    ```bash
    docker compose -f docker-compose.dev.yml up -d
    ```

    `docker compose -f docker-compose.dev.yml ps` should show three healthy containers. They
    are named `lumastra-postgres` and `lumastra-valkey`, so stop a production Compose install
    on the same machine first.

4. Create the database schema and check your setup.

    ```bash
    npm run startup-migration
    npm run doctor
    ```

    The migration ends with `Schema migration completed successfully`. `doctor` prints any
    problem it finds with your configuration.

5. Start the web server.

    ```bash
    npm run dev
    ```

    Open <http://localhost:5173>. You should see the setup wizard.

6. In a second terminal, start the task worker. Run exactly one.

    ```bash
    npm run dev:worker
    ```

    The first start builds the Rust watcher, which takes a few minutes.

Every setting is listed in the [environment variable reference](https://lumastra.org/reference/environment-variables/). The website has the same steps at [Local development](https://lumastra.org/developers/local-development/).

## Check your changes

Run these before you open a pull request.

| Command                      | What it does                                  |
| ---------------------------- | --------------------------------------------- |
| `npm run typecheck`          | Type-checks the `.ts` files                   |
| `npm run check:svelte-types` | Type-checks the `.svelte` files (about 1 min) |
| `npm run lint`               | ESLint and the repo's own rules               |
| `npm run format`             | Formats the files with Prettier               |
| `npm test`                   | Unit and component tests                      |

`npm run lint` needs a lot of memory. Do not run it twice at once.

A single test file:

```bash
npm test -- src/lib/utils/data-extraction.test.ts
```

## Tests that need a database

Integration tests (`*.integration.test.ts`) use their own database, `lumastra_tests`, on the PostgreSQL from step 3. Create it once, then run them:

```bash
npm run db:test:create
npm run db:test:migrate
npm run test:integration
```

Never point `TEST_DATABASE_URL` at your real `lumastra` database. The tests delete rows.

Browser and API tests use Playwright. Start `npm run dev` first, then:

```bash
npm run test:e2e:api    # API tests only
npm run test:e2e        # API and browser tests
```

## Build

```bash
npm run build
npm run preview
```

The build writes to `build/` and needs about 4 GB of memory.

## Project layout

| Path                    | What is in it                                   |
| ----------------------- | ----------------------------------------------- |
| `src/routes/`           | Pages and HTTP routes (SvelteKit)               |
| `src/lib/server/`       | Server code: database, services, tasks, plugins |
| `src/lib/components/`   | Svelte components                               |
| `src/task-runtime/`     | The task worker                                 |
| `native/`               | Rust: file watcher, Live TV proxy, task queue   |
| `plugins/`, `packages/` | Bundled plugins and the plugin SDK              |
| `workers/`              | The sonic music-analysis sidecar                |
| `messages/`             | Translation files (English and German)          |
| `tests/`                | Playwright, API and contract tests              |
| `scripts/`              | Build, OpenAPI and check scripts                |
| `docs/`                 | Design notes for contributors                   |
| `deploy/`               | Helm chart and Kubernetes examples              |

Unit tests sit next to the code they test.

## Read more

- [AGENTS.md](../../AGENTS.md) has the architecture and the rules every change follows. Many folders also have their own `CLAUDE.md` with notes for that area, for example [`src/lib/server/CLAUDE.md`](../../src/lib/server/CLAUDE.md).
- [docs/README.md](../README.md) lists the architecture notes in `docs/architecture/`.
- [Contributing](../../.github/CONTRIBUTING.md) explains how to send a pull request.
- [Testing traps](testing-traps.md) lists the mistakes people make in tests.
- The [API reference](https://lumastra.org/reference/) and the [OpenAPI spec](../api/api-v1.yaml) describe the public API.
