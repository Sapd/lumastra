# Health checks

All of these are read-only. Run them in the install folder (the one with
`docker-compose.yml` and `.env`). Use the service names (`lumastra`,
`lumastra-postgres`, `lumastra-valkey`) with `docker compose`: the example compose
file sets no fixed container names, so the containers are called
`<project>-lumastra-1` and so on.

## 1. Containers

```bash
docker compose ps
docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}} exit={{.State.ExitCode}}' $(docker compose ps -aq lumastra)
```

`lumastra`, `lumastra-postgres` and `lumastra-valkey` should be `running` and
`healthy`. A rising restart count or `oom=true` points to
[memory](common-causes.md#memory). An exit right after start points to the startup
log below.

The compose healthcheck calls `/api/health` inside the container every 30 seconds,
after a 60-second start period, so "healthy" only means the web server answers.

## 2. Logs

```bash
docker compose logs --tail=200 lumastra
docker compose logs --since=30m lumastra | grep -iE 'error|fatal|fail|warn' | tail -50
docker compose logs --tail=50 lumastra-postgres lumastra-valkey
```

The startup runs in this order. The last line that appears tells you where it
stopped:

| Log line                                                                          | Meaning                                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `Starting Lumastra container...`                                                  | The container started                                                               |
| `Ensuring transcode engine...`                                                    | FFmpeg is downloaded or found in `/config/bin`                                      |
| `Running database migration...`                                                   | The migration step started                                                          |
| `Configuration preflight failed with N error(s)`                                  | The config doctor found errors (listed above the line); start is aborted            |
| `Schema migration completed successfully`                                         | The database schema is up to date                                                   |
| `DB-aware preflight failed with N error(s)`                                       | Database or Valkey unreachable, or an embedding column mismatch                     |
| `STARTUP MIGRATION FAILED`                                                        | The migration failed; the error and a `TROUBLESHOOTING:` list follow                |
| `Migration failed, check logs above`                                              | The container exits with code 1                                                     |
| `Starting application server...`                                                  | The web server starts                                                               |
| `PostgreSQL connection verified` / `Valkey (Redis) connection verified`           | Both connections work                                                               |
| `FATAL: Cannot connect to PostgreSQL` / `FATAL: Cannot connect to Valkey (Redis)` | See [database and cache connection](common-causes.md#database-and-cache-connection) |

`LUMASTRA_SKIP_PREFLIGHT=true` lets the start continue past preflight errors. Don't
set it to get past an error you haven't understood.

Logs mask the database password in connection URLs. Still read log output before you
paste large parts of it to the person, and leave out tokens if any appear.

## 3. Health endpoints

```bash
curl -fsS http://localhost:3000/api/health          # liveness
curl -sS -w ' HTTP %{http_code}\n' http://localhost:3000/api/health/ready   # readiness
```

- `/api/health` always returns `{"status":"pass"}` with HTTP 200 while the web server
  runs. It checks neither PostgreSQL nor Valkey.
- `/api/health/ready` returns 200 `{"status":"pass"}` only when the task orchestrator
  is healthy, PostgreSQL answers `SELECT 1` and Valkey answers `PING`, each within
  2 seconds. Otherwise it returns 503 `{"status":"fail"}`.

If the port is not published on the host (the proxy reaches Lumastra over the compose
network), run the same `curl` inside the container:
`docker compose exec lumastra curl -fsS http://localhost:3000/api/health/ready`.

Through the proxy, `curl -i https://<domain>/api/health` must also return 200 with
`{"status":"pass"}`. If it works locally but not through the proxy, the problem is in
the proxy: see [reverse-proxy.md](reverse-proxy.md).

Signed in as admin in a browser, `/api/health?detail=true` adds the state of
PostgreSQL, Valkey and Jellyfin, FFmpeg, and auth issues.

## 4. Config doctor

```bash
docker compose exec lumastra npm run doctor
```

It checks the environment of the running container and prints one line per issue as
`[category/code] message` with a `→` line that says what to do. Exit code 1 means at
least one error. It doesn't print secret values. Codes you may see:

- `secrets.master-key-missing`: no master key and none could be generated, usually
  because `/config` is not writable.
- `secrets.jwt-secret-missing`: no `JWT_SECRET` and no master key to derive it from.
- `transport.session-cookie-secure-info` (note): neither `ORIGIN` nor `PROTOCOL_HEADER`
  is set. The session cookie is still `Secure` unless the request shows plain HTTP, so
  sign-in works over plain HTTP on the local network. Behind a proxy `ORIGIN` is
  required: set it to the `https` address to make the cookie `Secure` on every request.
- `forward-auth.fail-closed`: no sign-in method works: built-in login and OIDC are off,
  and forward auth is either off (`FORWARD_AUTH_ENABLED`) or has no trusted proxy.
- `forward-auth.trusts-wide-range`: `TRUSTED_PROXY_IPS` has an IPv4 range wider than
  `/24` or an IPv6 range. A note on Kubernetes (pod range behind a NetworkPolicy). See
  [forward auth](common-causes.md#forward-auth).
- `forward-auth.headers-while-disabled`, `forward-auth.enabled-without-trusted-proxy`,
  `forward-auth.disabled-with-trusted-proxy` (note): see
  [forward auth](common-causes.md#forward-auth).
- `forward-auth.trust-any`, `forward-auth.trusts-docker-gateway`: see
  [forward auth](common-causes.md#forward-auth).

The CLI doesn't test the database or Valkey connection. The same doctor runs at every
start with those connection checks added (`database.unreachable`,
`cache.unreachable`), so look for them in the startup log.

## 5. Settings, without printing secrets

Effective values inside the container. `printenv` with names prints only those
variables:

```bash
docker compose exec lumastra printenv ORIGIN FORWARD_AUTH_ENABLED TRUSTED_PROXY_IPS BODY_SIZE_LIMIT LUMASTRA_LOW_RAM_MODE WORKER_MODE AUTH_OIDC_ENABLED AUTH_OIDC_ISSUER USERHEADER GROUPHEADER
```

A missing line means the variable is unset. Values in the `environment:` block of
`docker-compose.yml` win over the same name in `.env`.

Secrets, checked by pattern. Each command prints a count, never the value:

```bash
grep -c -E '^DATABASE_PASSWORD=[0-9a-f]+$' .env      # 1 = hex
grep -c -E '^CACHE_PASSWORD=[0-9a-f]+$' .env         # 1 = hex
grep -c -E '^LUMASTRA_MASTER_KEY=[0-9a-f]{64}$' .env # 1 = set as 64 hex characters
grep -c -E '^LUMASTRA_MASTER_KEY=' .env              # 0 = not set in .env
docker compose exec lumastra test -s /config/master.key && echo 'master.key present'
docker compose config --quiet && echo 'compose file valid'
```

## 6. Resources

```bash
docker stats --no-stream
df -h . /var/lib/docker 2>/dev/null
docker system df
```

A full disk breaks PostgreSQL writes and image pulls. Don't run `docker system prune`
or `docker volume prune` without asking: the volume prune deletes the database of a
stopped stack.

## 7. In the admin UI

Signed in as admin:

- **Admin → System → Health** (`/admin/system/health`): open findings, component
  state, optional dependencies, provider health, file health and the security
  self-check. Findings include "a sealed setting no longer decrypts" and a Valkey
  eviction policy that can drop task data.
- **Admin → Fix** (`/admin/fix`): pages by symptom, for example "Logins fail or
  everyone looks logged out" (`/admin/fix/proxy`, which shows what the proxy actually
  sends), "New files aren't showing up", "My server is slow", "Everything looks
  stuck".

## Kubernetes

With the Helm chart, use `kubectl -n <namespace> get pods`, `kubectl logs` and
`kubectl exec <pod> -- npm run doctor` in place of the compose commands. The same
endpoints and log lines apply. See https://lumastra.org/guides/deploy-kubernetes/.
