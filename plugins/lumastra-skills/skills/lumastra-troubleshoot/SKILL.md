---
name: lumastra-troubleshoot
description: Use when a Lumastra media server that is already installed misbehaves - it won't start, /api/health fails, logins fail or loop, the Apple apps can't connect, playback stops or is refused, uploads fail with 413, OIDC or forward-auth sign-in doesn't work, stored secrets no longer decrypt, the container crashes or runs out of memory, libraries stay empty, or background tasks look stuck. Covers read-only health checks, the reverse proxy checklist, the common causes and their fixes, the admin task and diagnostics pages, and where client reports from the iPhone, iPad and Apple TV apps arrive. For a new install, use lumastra-install instead.
---

# Troubleshoot Lumastra

You are helping a person whose Lumastra install misbehaves. Find the cause with
read-only checks first, then propose a fix and apply it only after they agree.
The human-readable references are https://lumastra.org/reference/known-limitations/
and https://lumastra.org/guides/reverse-proxy/.

## Rules

- Read first. Collect logs, health output and configuration before you change
  anything.
- Before any change, show the person the relevant error lines and the fix you
  propose, and wait for a yes.
- Never print secrets: `DATABASE_PASSWORD`, `CACHE_PASSWORD`, `LUMASTRA_MASTER_KEY`,
  `JWT_SECRET`, `AUTH_OIDC_CLIENT_SECRET`, API keys and tokens. Don't run `cat .env`,
  `docker compose config` without `--quiet`, `docker compose exec lumastra env`, or
  `printenv` without variable names. Check secrets by pattern with `grep -c`; read
  other settings by name, as shown in
  [references/health-checks.md](references/health-checks.md).
- Ask before you delete or recreate a volume, a container with data, the database,
  `/config` or `master.key`, and before any `docker compose down -v`. Never generate a
  new `LUMASTRA_MASTER_KEY` to replace a lost one without asking: it makes the stored
  secrets unreadable for good.
- Ask before you edit `docker-compose.yml`, `.env` or the proxy configuration, and
  keep a copy of the file you change.

## 1. Ask what is wrong

- What happens, since when, and what changed just before (update, new proxy, moved
  server, edited `.env`).
- Where it runs: Docker Compose (the default) or Kubernetes with the Helm chart. For
  Kubernetes, use `kubectl logs` and `kubectl exec` in place of the compose commands
  and read https://lumastra.org/guides/deploy-kubernetes/.
- The install folder (default `~/lumastra`), the public address, and the proxy.
- Which clients fail: browser, iPhone, iPad, Apple TV, or a third-party player.

## 2. Run the health checks

Follow [references/health-checks.md](references/health-checks.md): container state,
the logs, `/api/health`, `/api/health/ready`, `npm run doctor` inside the container,
and the settings that matter, read without printing secrets. Report what you found
before you go on.

## 3. Match the symptom

| Symptom                                                                                                                        | Read                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 502, 413, logins fail with 403 or loop, signed out on the next request, live updates late, playback stops after about a minute | [references/reverse-proxy.md](references/reverse-proxy.md)                               |
| Apple apps can't connect                                                                                                       | [references/common-causes.md](references/common-causes.md#apple-apps-cant-connect)       |
| Container exits at start, migration fails, `Cannot connect to PostgreSQL`                                                      | [references/common-causes.md](references/common-causes.md#database-and-cache-connection) |
| Secrets don't decrypt, everyone signed out after a move or restore                                                             | [references/common-causes.md](references/common-causes.md#master-key-lost-or-changed)    |
| Crash with `Illegal instruction`, `exec format error`, features missing on ARM                                                 | [references/common-causes.md](references/common-causes.md#cpu-and-architecture)          |
| Restarts, OOM kills, heap out of memory, slow under load                                                                       | [references/common-causes.md](references/common-causes.md#memory)                        |
| OIDC sign-in fails                                                                                                             | [references/common-causes.md](references/common-causes.md#oidc)                          |
| Forward-auth sign-in fails                                                                                                     | [references/common-causes.md](references/common-causes.md#forward-auth)                  |
| Playback refused with a stream or transcode limit                                                                              | [references/common-causes.md](references/common-causes.md#stream-and-transcode-limits)   |
| Library empty, new files not showing up                                                                                        | [references/common-causes.md](references/common-causes.md#library-paths)                 |
| Tasks stuck, queue not draining, a client error with a reference                                                               | [references/admin-pages.md](references/admin-pages.md)                                   |

If nothing matches, check https://lumastra.org/reference/known-limitations/: the
behaviour may be a known limit of v0.1.

## 4. Fix and verify

Propose one change at a time. After the person agrees, apply it, restart what it
needs (`docker compose up -d` picks up `.env` and compose changes), and run the
health checks again. Report what you changed, which files you edited, and what the
checks show now.

## 5. When it stays broken

Ask the person to open **Admin → System → Export diagnostics**
(`/admin/system/diagnostics`). It produces a redacted report (version, environment,
health findings, FFmpeg and GPU capabilities, migrations, changed settings, recent
failures) meant for a public issue. They attach it, with the log lines you found,
to a report at https://github.com/Sapd/lumastra/issues. Let them read the report
before they post it.
