# Common causes

Each section gives the symptom, a read-only check, and the fix to propose. Show the
person the evidence and the fix before you change anything.

## Apple apps can't connect

The iPhone, iPad and Apple TV apps only connect to a server on HTTPS with a
certificate the device trusts. Plain HTTP, a bare IP address with HTTP, and
self-signed certificates don't work.

Check:

- `curl -i https://<domain>/api/health` from outside the server returns 200 and
  `{"status":"pass"}` without a certificate error.
- The person opens the address in Safari on the same device. A certificate warning
  there means the app fails too.
- **Admin → Settings → Access → Public API & Device Auth** is on
  (`FEATURE_DEVICE_AUTH`, on by default). The apps sign in through it.

Fix: a reverse proxy with a certificate from a public authority such as Let's Encrypt,
see [reverse-proxy.md](reverse-proxy.md). The apps sign in by showing a short code
that the person approves at `/device` on the server.

## Database and cache connection

The compose file builds the connection strings from the two passwords in `.env`:

```yaml
DATABASE_URL: 'postgresql://lumastra:${DATABASE_PASSWORD}@lumastra-postgres:5432/lumastra'
CACHE_URL: 'redis://default:${CACHE_PASSWORD}@lumastra-valkey:6379/0'
```

**Non-hex passwords.** `/`, `+`, `=`, `@`, `:` or `#` in a password break the URL, so
the connection fails even though the password is right. Check with
`grep -c -E '^DATABASE_PASSWORD=[0-9a-f]+$' .env` (and the same for
`CACHE_PASSWORD`); `0` means the value has other characters. Fix: a new hex password
from `openssl rand -hex 24`. For `CACHE_PASSWORD` this is enough, because Valkey reads
it at every start. For `DATABASE_PASSWORD` see the next point first.

**`DATABASE_PASSWORD` changed after the first start.** The PostgreSQL image sets the
password only when it creates an empty data volume. Changing `.env` later doesn't
change it, and the log shows `password authentication failed for user "lumastra"`.
Fix, in this order of preference: put the old password back in `.env`; or set the
database user to the new password, which the person runs themselves so the value
stays out of the chat:

```bash
docker compose exec lumastra-postgres psql -U lumastra -d lumastra -c "ALTER USER lumastra PASSWORD '<new hex password>'"
```

Never delete the `lumastra_postgres_data` volume to get past this: it holds the
whole database.

**`.env` not read.** Compose reads `${DATABASE_PASSWORD}` only from a file named
exactly `.env` next to `docker-compose.yml`, or from the shell. A missing value stops
`docker compose up` with `DATABASE_PASSWORD is required`.

**PostgreSQL version.** Lumastra needs PostgreSQL 17 or newer with `pgvector`; the
example uses `pgvector/pgvector:pg18`. Changing the image's major version on an
existing volume makes PostgreSQL refuse to start with the old data files. Put the
previous image back and follow PostgreSQL's upgrade procedure with a backup.

Other log lines: `FATAL: Cannot connect to PostgreSQL` or
`FATAL: Cannot connect to Valkey (Redis)` at start, or `database.unreachable` /
`cache.unreachable` in the preflight. Check `docker compose logs lumastra-postgres
lumastra-valkey` and that both are healthy.

## Master key lost or changed

`LUMASTRA_MASTER_KEY` encrypts every secret Lumastra stores: API keys and passwords
entered in the admin UI, plugin secrets, webhook signing secrets, Subsonic tokens,
Jellyfin-compatible client passwords and Live TV provider logins. Unless `JWT_SECRET`
is set, login tokens are signed with a key derived from it too.

Where it comes from, in this order: the `LUMASTRA_MASTER_KEY` variable, then
`/config/master.key` in the `config` volume. With neither, Lumastra generates a new
key into `/config/master.key` and logs
`[MasterKey] No LUMASTRA_MASTER_KEY set — generated a new encryption key`. So a lost
key doesn't stop the server; it starts with a new one, and the old secrets stay
unreadable.

Symptoms after a move, a restore, a new `.env` or a lost `config` volume:

- Everyone, including the Apple apps and TV clients, is signed out.
- Log: `[ConfigService] N sensitive setting(s) could not be decrypted and are NOT in
effect — the app is running on their defaults: <keys>`, or
  `Secret decrypt failed (...)` for plugin secrets.
- **Admin → System → Health** shows "a sealed setting no longer decrypts".
- Webhooks fail, Subsonic clients can't sign in, a Live TV source stops refreshing,
  and clients paired through the `/j` compatibility layer see a new server.
- `[MasterKey] Two different master keys are configured`: the variable and
  `/config/master.key` differ. The variable wins and the file is ignored.
- `[ConfigService] LUMASTRA_MASTER_KEY is invalid`: the value is not 64 hex characters
  or a passphrase of at least 24 characters with two character classes.

Check without printing it: the `grep -c` lines in
[health-checks.md](health-checks.md#5-settings-without-printing-secrets).

Fix: restore the previous key from the person's backup (password manager, old `.env`,
a backup of the `config` volume) into `.env` and run `docker compose up -d`. Don't
generate a new key unless they confirm the old one is gone; then the affected secrets
must be entered again by hand, and users sign in again. Changing to a new key on
purpose needs the rotation in **Admin → Settings → Secrets → Rotate Master Key**
while the old key is still in effect:
https://lumastra.org/guides/master-key-rotation/.

## CPU and architecture

**x86-64 without x86-64-v2.** The `sharp` image library needs SSE4.2 and POPCNT.
Lumastra doesn't check this at start; the process fails when image processing first
runs, typically with `Illegal instruction`. Check:

```bash
uname -m
grep -o -w 'sse4_2\|popcnt' /proc/cpuinfo | sort -u
```

Both flags must be printed. In a virtual machine, emulated CPU models such as `qemu64`
or `kvm64` lack them. Fix: `host-passthrough` or a Nehalem-or-newer CPU model in the
hypervisor; the person changes this on the VM host.

**ARM (`aarch64`, `arm64`).** Release tags (`:stable`, `:latest`, version tags) are
built for amd64 and arm64. `:edge` is amd64 only and fails on ARM with
`exec format error`; use `:stable`. These features are not available on arm64, and
each logs a warning and the rest keeps working:

- Music BPM and mood analysis (no Essentia build for arm64; the log says
  `Essentia binary not found — music audio analysis will be skipped`).
- The sound-similarity sidecar (`--profile sonic`); its image has no arm64 build.
- Intel Quick Sync / VA-API transcoding.

Docker Desktop on Windows also turns music analysis off; the log says
`Essentia self-test FAILED` once.

## Memory

8 GB of RAM is recommended for the app, the background tasks, PostgreSQL and Valkey.
The tasks that scan and analyse the library use most of it.

Symptoms: the container restarts, `oom=true` in the `docker inspect` line in
[health-checks.md](health-checks.md#1-containers), `JavaScript heap out of memory` in
the log, or the host swaps heavily under `docker stats`.

`LUMASTRA_LOW_RAM_MODE=true` (set in the example compose file) caps the Node.js heap
at 1536 MB for an all-in-one or worker container and 768 MB for a web-only container
(`WORKER_MODE=disabled`). The log shows
`LUMASTRA_LOW_RAM_MODE: capping V8 old-space at ...`. It does nothing if `NODE_OPTIONS`
already has `--max-old-space-size`. It doesn't turn features off.

Fix: keep it on below 8 GB. If the heap itself runs out on a host with spare RAM,
remove the line or raise the cap with
`NODE_OPTIONS=--max-old-space-size=<MB>`. Below about 4 GB only a small library runs
well. See https://lumastra.org/guides/performance-tuning/.

## OIDC

Settings are `AUTH_OIDC_*` (`AUTH_OIDC_ENABLED`, `AUTH_OIDC_ISSUER`,
`AUTH_OIDC_CLIENT_ID`, `AUTH_OIDC_CLIENT_SECRET`, `AUTH_OIDC_SCOPES`,
`AUTH_OIDC_GROUPS_CLAIM`) plus `ADMIN_GROUPS`. They can be set in `.env` or in
**Admin → Settings → Access**. Guide: https://lumastra.org/guides/sso-oidc/.

The login page shows only a generic message ("Single sign-on is unavailable.",
"Sign-in failed. Please try again.") with a short reference. Search the log for that
reference to find the cause:

```bash
docker compose logs --since=1h lumastra | grep -i -e oidc -e '<reference>'
```

| Log or message                                                              | Cause and fix                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider reports a redirect URI mismatch                                    | Register exactly `https://<domain>/auth/oidc/callback`. Without `ORIGIN`, Lumastra behind a TLS proxy builds an `http://` callback; set `ORIGIN`. `AUTH_OIDC_REDIRECT_URI` overrides the callback.                                                                                                                 |
| `OIDC is not enabled or is missing AUTH_OIDC_ISSUER / AUTH_OIDC_CLIENT_ID.` | Set both.                                                                                                                                                                                                                                                                                                          |
| `AUTH_OIDC_ISSUER must be https://`                                         | The issuer must use HTTPS.                                                                                                                                                                                                                                                                                         |
| `OIDC discovery failed: ...`                                                | Lumastra can't fetch `<issuer>/.well-known/openid-configuration` from inside the container. Use the issuer exactly as the provider shows it, and check that the container can resolve and reach it with a trusted certificate: `docker compose exec lumastra curl -fsS <issuer>/.well-known/openid-configuration`. |
| `The first user must be in an admin group (see ADMIN_GROUPS).`              | On a fresh install the first OIDC user must be in a group listed in `ADMIN_GROUPS` (default `admin`). Check that the provider sends groups in the ID token and that `AUTH_OIDC_GROUPS_CLAIM` names the claim.                                                                                                      |
| `OIDC groups claim resolved to no groups`                                   | Wrong `AUTH_OIDC_GROUPS_CLAIM`. Keycloak usually needs `realm_access.roles`.                                                                                                                                                                                                                                       |
| Users come in without admin rights                                          | Their groups don't match `ADMIN_GROUPS`. Google sends no groups; promote those users in **Admin → Users**.                                                                                                                                                                                                         |
| `Login state mismatch` or `Unknown or expired login transaction`            | The login took too long, or the browser returned on another address than it started from, so the state cookie was missing. Check `ORIGIN` and the provider's redirect URI.                                                                                                                                         |
| A forward-auth proxy also fronts Lumastra and OIDC loops                    | Let `/auth/oidc/login`, `/auth/oidc/callback` and `/auth/oidc/backchannel-logout` through without authentication.                                                                                                                                                                                                  |

## Forward auth

The proxy sends the user in `USERHEADER` (default `X-Forwarded-User`) and groups in
`GROUPHEADER` (default `X-Forwarded-Groups`). Lumastra reads these headers only when
`FORWARD_AUTH_ENABLED=true` (off by default) AND the peer is listed in `TRUSTED_PROXY_IPS`
(or any peer with `LUMASTRA_TRUST_ANY_PROXY=true`). Missing either, nobody can sign in
through it. An install upgraded from before 2026-10 that signed in through forward auth
needs `FORWARD_AUTH_ENABLED=true` added.
Guide: https://lumastra.org/guides/authentication/#forward-authentication.

| Log line                                                                                                                                     | Cause and fix                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Forward-auth: identity headers ignored — untrusted TCP peer` or `Forward-auth headers from an untrusted TCP peer were ignored`              | The peer address is not in `TRUSTED_PROXY_IPS`. The log line and `/admin/fix/proxy` name the address Lumastra sees; put that address in the list (see [reverse-proxy.md](reverse-proxy.md#which-address-does-lumastra-see)).                                                                                                                                            |
| `Forward-auth identity headers from a trusted proxy were ignored: FORWARD_AUTH_ENABLED is off`, doctor `forward-auth.headers-while-disabled` | Forward auth is off. If the person signs in through the proxy, set `FORWARD_AUTH_ENABLED=true` and restart. Otherwise the proxy passes client-sent identity headers through: fix it to remove them (see [reverse-proxy.md](reverse-proxy.md)).                                                                                                                          |
| Doctor `forward-auth.enabled-without-trusted-proxy`                                                                                          | `FORWARD_AUTH_ENABLED=true` but `TRUSTED_PROXY_IPS` is empty, so every identity header is rejected. Set the proxy's address (see [reverse-proxy.md](reverse-proxy.md#which-address-does-lumastra-see)).                                                                                                                                                                 |
| `Forward-auth: identity headers ignored — unexpanded reverse-proxy placeholder`                                                              | The proxy sends a template such as `{http.auth.user.id}` literally. Fix the header mapping (Caddy `header_up`, nginx `proxy_set_header`, Traefik `authResponseHeaders`).                                                                                                                                                                                                |
| `Forward-auth (reverse-proxy identity headers) is disabled: TRUSTED_PROXY_IPS is unset`                                                      | Startup warning. Harmless with built-in or OIDC login; set `TRUSTED_PROXY_IPS` for forward auth.                                                                                                                                                                                                                                                                        |
| Doctor `forward-auth.trusts-docker-gateway`                                                                                                  | `TRUSTED_PROXY_IPS` covers the Docker gateway, so every process on the host can send identity headers. Run the proxy on the compose network with a fixed address and trust only that.                                                                                                                                                                                   |
| Doctor `forward-auth.trusts-wide-range`, self-check `proxy.wide-range`                                                                       | `TRUSTED_PROXY_IPS` holds a range wider than `/24` (a LAN or a Docker /16) or an IPv6 range (matches nothing). Every device in the range can choose its client address and, with forward auth on, sign in as anyone. List only the proxy's own address, e.g. the compose proxy's fixed IP. On Kubernetes the router pod range behind the chart's NetworkPolicy is fine. |
| `settings.json sets FORWARD_AUTH_ENABLED=…, which is ignored`                                                                                | `FORWARD_AUTH_ENABLED` is environment-only. Put `FORWARD_AUTH_ENABLED=true` in `.env` (or the container environment) and remove the key from `settings.json`.                                                                                                                                                                                                           |
| Doctor `forward-auth.trust-any`                                                                                                              | `LUMASTRA_TRUST_ANY_PROXY=true` trusts every peer. Safe only if port 3000 can't be reached except through the proxy.                                                                                                                                                                                                                                                    |
| A user without groups keeps admin rights                                                                                                     | nginx drops empty headers. Use the nginx `map` from https://lumastra.org/guides/sso-authentik/ or set `FORWARD_AUTH_GROUPS_ALWAYS_SENT=true`.                                                                                                                                                                                                                           |

If forward auth locks the admin out, built-in login at `/login` still works when it is
enabled (`AUTH_NATIVE_LOGIN_ENABLED`).

## Stream and transcode limits

| What the client sees                                                                                                                                                          | Limit                                                                                                                                                    | Where to change it                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| "You're already watching on as many devices as your account allows (N of M)." (HTTP 422 `stream_limit_exceeded`), or `Stream limit reached: N of M streams in use` (HTTP 429) | Concurrent streams per user. Default `DEFAULT_MAX_CONCURRENT_STREAMS=-1` (unlimited); a per-user value of 0 blocks all playback                          | **Admin → Users** → the user's stream policy; the default under **Admin → Settings → Playback** |
| `Maximum N concurrent transcode jobs per user` (HTTP 429)                                                                                                                     | `FFMPEG_MAX_JOBS_PER_USER`, default 10                                                                                                                   | **Admin → Settings → Playback**                                                                 |
| HTTP 503 when starting a transcode                                                                                                                                            | Server-wide `LUMASTRA_MAX_CONCURRENT_TRANSCODES` (default from the CPU count) with no idle job to stop, or `LUMASTRA_TRANSCODE_LOAD_SHED_RATIO` when set | **Admin → Settings → Playback**                                                                 |
| Live TV refuses a viewer                                                                                                                                                      | The source's own stream limit                                                                                                                            | https://lumastra.org/guides/live-tv/                                                            |

`STREAM_LIMITS_ENFORCED=false` turns the per-user stream limit off; other per-user
policies still apply.

## Library paths

Lumastra sees only what is mounted into the container, and the library paths in the
admin UI are paths inside the container, for example `/data/media/movies`. The
`volumes:` lines of the `lumastra` service map host folders to those paths. Adding a library path doesn't check that it exists.

Check:

```bash
grep -n ':/data/' docker-compose.yml
docker compose exec lumastra ls /data/media
docker compose exec lumastra sh -c 'ls /data/media/movies | head'
docker compose exec lumastra id
```

The container runs as uid 1000 (`node`). The host folders must be readable by that
uid, or world-readable; check with `ls -ldn` on the host. Mounts should be read-only
(`:ro`).

Log lines:

- `File scanner: walk of <path> had readdir/stat errors`: the folder is missing or
  unreadable. Lumastra skips the cleanup of removed files for that path, so existing
  items stay in the library.
- `cannot resolve library root "<path>"`: the library root doesn't exist in the
  container.
- `ENOENT during probe but parent dir also missing`: the folder of a file is gone,
  usually because a network share went offline. The library entry is kept.
- `Permission denied`: the uid 1000 can't read the file.

Fix: add or correct the `volumes:` line on the `lumastra` service, run
`docker compose up -d`, then start a scan. **Admin → Library → Sources**
(`/admin/library/sources`) lists the paths; **Admin → Fix → New files aren't showing
up** walks through the rest. Media on S3 or other object storage sends no file events;
use a scheduled scan. Filename encoding problems on Windows shares:
https://lumastra.org/guides/windows-media-shares/.
