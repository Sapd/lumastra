<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Lumastra Helm chart (beta)

> **Beta.** lumastra.org's own instance runs on this chart, but it has one production install so
> far, and values and defaults may still change between chart versions. Docker Compose stays the
> main supported way to run Lumastra; Kubernetes support is best-effort until 1.0. The chart is
> installed from this directory (no chart repository yet). The full guide is at
> https://lumastra.org/guides/deploy-kubernetes/. The plain manifests in `deploy/k8s/` remain as
> examples.

One image (`ghcr.io/lumastra/lumastra`) runs every app role. The start script, passed as container
`args`, picks the role. The image entrypoint is `tini`, so the chart never sets `command`.

| Component                       | What                                                                   | Default                                |
| ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| `web`                           | UI / API / HLS (`WORKER_MODE=disabled`), a **StatefulSet** (`web-0…N`) | 2 replicas, one-at-a-time updates, PDB |
| `worker`                        | lean TypeScript tasks/plugins + Rust watcher child                     | 1 (0 or 1), Recreate                   |
| `router`                        | nginx affinity router + optional forward-auth                          | on                                     |
| `proxy`                         | Live TV stream proxy                                                   | off                                    |
| `sonic`                         | sonic embedder sidecar (amd64)                                         | off                                    |
| `valkey-cache` / `valkey-tasks` | persistent noeviction tasks + separate evictable cache                 | on                                     |
| CNPG `Cluster`                  | optional, `database.mode: cnpg`                                        | off (external DB)                      |

Only `mode: split` is supported. Web pods serve requests and submit tasks;
exactly one dedicated lean TypeScript worker runs the existing tasks/plugins and
supervises one credential-free Rust watcher child in its container. The worker
uses the Rust watcher only. Combined mode and the legacy task-host selector are removed. BullMQ and
the two Valkey policies remain unchanged.

## Quick start

```bash
kubectl create namespace lumastra
kubectl -n lumastra create secret generic lumastra \
  --from-literal=LUMASTRA_MASTER_KEY="$(openssl rand -hex 32)" \
  --from-literal=CACHE_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=DATABASE_URL='postgresql://lumastra:<pw>@<host>:5432/lumastra'
helm install lumastra deploy/helm/lumastra -n lumastra \
  --set secrets.existingSecret=lumastra \
  --set app.origin=https://lumastra.example.com \
  -f my-values.yaml            # libraries, storage classes, route …
```

**Storage.** The default `mode: split` (web StatefulSet + worker) needs a `ReadWriteMany` storage
class for `/config`, the transcode volume and the plugins volume, because web and worker pods on
different nodes mount them at the same time. Without one, pin every pod
to one node and set `accessModes: [ReadWriteOnce]` on those volumes. See "Storage" below.
A stock single-node k3s (`local-path` storage) is this case: start from
`ci/single-node-values.yaml`.
Admin uploads stage their parts inside the library folder, so they work across pods as long as
the libraries are mounted on every pod. If you set `UPLOAD_STAGING_DIR`, it must be a volume every
pod mounts at the same path (System health warns when an upload's parts are not visible).

Then open `https://<host>/setup`, pick the sign-in method, create the admin and add the library
paths (the `mountPath`s from `libraries`). **Back up `LUMASTRA_MASTER_KEY`**: it encrypts stored secrets.

Example value sets for every topology are in `ci/*-values.yaml`.

## Routing: why there is a router

An HLS session's FFmpeg job runs on the web pod that started it. That pod is recorded in
`active_transcode_jobs.pod_name`, which is the pod's `HOSTNAME`. Another pod that receives the
session's requests answers `503` with `Retry-After: 2` while the owner is still serving it. Once the
owner has been idle for 15 s, the new pod takes the session over: it serves segments already on the
shared transcode volume or restarts FFmpeg. Correctness survives, but every misrouted request costs
retries and latency, so requests must stick.

The router (nginx ≥ 1.27.3) hashes each request with `hash … consistent` on a key built as follows:

1. the `grant` query argument (the playback grant), if present;
2. otherwise `PlaySessionId`, except `preview-*` ids;
3. otherwise the client IP.

The app appends `grant` and `PlaySessionId` to every playlist, segment and init URL it emits, and
renewing a grant keeps its secret, so a whole session hashes the same.

The upstream has **one `server` line per web pod**: `<release>-web-<n>.<release>-web-headless…:3000
resolve`, re-resolved every `router.dnsValid`. This is why web is a StatefulSet. Open-source nginx
round-robins the addresses of a single multi-address name instead of hashing them. Only Ready pods
have a DNS record, and a slot without one is skipped. The chart renders exactly `web.replicas`
lines, so changing `web.replicas` through Helm/Argo re-renders the router (its pods roll). Only for
an HPA set `router.webSlots` above `web.replicas`: the router then has lines for pods that do not
exist yet, and **every router pod logs a "could not be resolved" error for each empty slot every
`router.dnsValid`** (nginx has no quiet mode for that, and `backup` servers are not allowed with
`hash`). With `web.replicas: 0` the router renders a static placeholder and answers 502. Several
router replicas agree on the target because ketama hashing depends only on the configured server
lines.

What sits in front of the router (your gateway or ingress) needs **no** session affinity, only:

- no response buffering (HLS, SSE);
- long timeouts (≥ 1 h for SSE / long downloads);
- a request body limit ≥ `app.bodySizeLimit` (50 MB by default: artwork uploads; client
  diagnostics bundles need ≥ 3 MiB);
- WebSocket upgrade (`/j/socket`).

Set `router.realIp.fromCIDRs` to the addresses of that edge. The router then sees the real client IP:
it feeds the hash fallback and the app's client IP, which the router passes on as a single-entry
`X-Forwarded-For`.

**Client address for playback grants.** A playback grant (and a PAT or service-token `allowed_ips`
list) is pinned to the client address that started playback. Behind the router, web's TCP peer is
a router pod, so web has to read the client from the router's `X-Forwarded-For`. A pod address
proves nothing (any pod that reaches `web:3000` could send that header), so the router
authenticates itself: it adds `X-Lumastra-Router-Hop`, the HMAC-SHA256 of `LUMASTRA_MASTER_KEY`
with the label `lumastra-router-hop-v1`. Web believes the forwarded client address of a request
that carries the matching value (constant-time compare), whatever its peer address, and removes the
header at once. Without this, each router pod would be "the client", and with more than one router
pod about half the segment requests would fail with `403 ip_mismatch`.

Nothing to configure: the default Secret from the Quick start already has `LUMASTRA_MASTER_KEY`
and `secrets.env.LUMASTRA_MASTER_KEY` maps it. A router init container (`hop-secret`, the app
image) derives the value from it and writes an nginx include into a memory `emptyDir`; the master
key is visible to that init container only, never to the nginx container, and the derived value
cannot be turned back into the key. Notes:

- The key must come from the Secret (env). A key generated into `/config/master.key` cannot be read
  by the router; then the hop stays off and the client address is the TCP peer (grants fail again
  with several router pods). The chart also skips the init container when `secrets.env` has no
  `LUMASTRA_MASTER_KEY`, or with `router.hop.enabled: false`.
- After rotating the master key, restart the router pods (`kubectl rollout restart deploy/<release>-lumastra-router`):
  the secret is derived when a pod starts.
- The hop grants **no identity trust**. Forward-auth identity headers stay governed by
  `auth.forwardAuth.trustedProxyIps` / `TRUSTED_PROXY_IPS` alone.
- `app.clientIpProxyIps` (`CLIENT_IP_PROXY_IPS`) is a separate, unauthenticated list of peers whose
  `X-Forwarded-For` is believed (for example your own proxy when `router.enabled: false`). The router
  does not need it. Never put a pod network there: any pod could then choose its client address
  (per-IP login rate limits, IP-pinned grants, token IP allowlists). The Security Self-Check warns
  about ranges wider than /24.

**Ingress requirement.** The router takes the client address from `X-Forwarded-For` when the peer is
in `router.realIp.fromCIDRs` (default: RFC 1918, `real_ip_recursive on`) and passes it on as a
single entry. The Ingress, gateway or load balancer in front must therefore **set or append** the
real peer address, never pass a client-supplied `X-Forwarded-For` through untouched: otherwise an
external client chooses its own address. Pod and node networks are not always RFC 1918 (IPv6,
dual-stack, 100.64.0.0/10 CGNAT): set `router.realIp.fromCIDRs` to your ingress controller's pods
or nodes. With `externalTrafficPolicy: Cluster` the client address is lost to SNAT before nginx sees it.

`router.resolver` must be a DNS server that answers for the cluster domain:
`kube-dns.kube-system.svc.cluster.local` works on most distributions including k3s, or use its IP.

## Authentication

Auth settings the Admin UI can also change are **not rendered unless you set them** (one exception: native login, see the table). Unset, the
app's own default applies and a value saved in the Admin UI (`/config/settings.json`) stays in
effect — including what the first-run `/setup` wizard saves and what a migrated install already
has. Set a value only to pin it: a rendered env value wins over the Admin UI and locks the
setting there (see "Configuration precedence").

| Value                                           | Env                                                            | Chart default                                | App default | Notes                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.native.enabled`                           | `AUTH_NATIVE_LOGIN_ENABLED`                                    | `true` without forward-auth/OIDC, else unset | `false`     | The app refuses to start without a sign-in method, so with no SSO the chart renders `true` (as Docker Compose's quick start does in `.env`). With forward-auth or OIDC it is unset: `settings.json` / the Admin UI decides. |
| `auth.deviceAuth`                               | `FEATURE_DEVICE_AUTH`                                          | unset                                        | `true`      | Apple/third-party apps, OAuth device flow, `/api/v1` tokens.                                                                                                                                                                |
| `auth.userPats`                                 | `FEATURE_USER_PATS`                                            | unset                                        | `false`     | Users mint personal access tokens.                                                                                                                                                                                          |
| `auth.adminGroups`                              | `ADMIN_GROUPS`                                                 | unset                                        | `admin`     | Comma-separated groups (forward-auth/OIDC) that are admins.                                                                                                                                                                 |
| `auth.watchPermissionGroups`                    | `WATCH_PERMISSION_GROUPS`                                      | unset                                        | (none)      |                                                                                                                                                                                                                             |
| `auth.forwardAuth.groupsAlwaysSent`             | `FORWARD_AUTH_GROUPS_ALWAYS_SENT`                              | unset                                        | `false`     | Only rendered with forward-auth.                                                                                                                                                                                            |
| `auth.forwardAuth.enabled`                      | `FORWARD_AUTH_ENABLED`                                         | `true` with forward-auth, else unset         | `false`     | The app reads identity headers only when this is on (opt-in since 2026-10).                                                                                                                                                 |
| `auth.forwardAuth.*` headers, `trustedProxyIps` | `USERHEADER`, `GROUPHEADER`, `NAMEHEADER`, `TRUSTED_PROXY_IPS` | rendered with `auth.forwardAuth.enabled`     |             | The router strips exactly these headers, so the chart owns them.                                                                                                                                                            |
| `auth.oidc.*`                                   | `AUTH_OIDC_*`                                                  | rendered with `auth.oidc.enabled`            |             | Client secret: `secrets.env.AUTH_OIDC_CLIENT_SECRET`.                                                                                                                                                                       |

`true`/`false` render that value (so `false` really turns a feature off); `null` leaves it to the
app. Migrating an install, compare these with its `settings.json` before the first sync.

- **No sign-in method.** The app refuses to start when built-in login is off and neither OIDC nor
  forward-auth is configured. The chart applies the same rule at render time:
  `auth.native.enabled: false` without `auth.oidc` or `auth.forwardAuth` fails to render. Env
  values set through `app.env`, the component `env`/`extraEnv` or `secrets.env` count too
  (`AUTH_OIDC_*`, `TRUSTED_PROXY_IPS`, `LUMASTRA_TRUST_ANY_PROXY`, `LUMASTRA_SKIP_PREFLIGHT`). A
  value the chart cannot read (a Secret, `valueFrom`, `extraEnvFrom`) is assumed to enable
  sign-in.
- **SSO configured only in the Admin UI.** The chart sees only its own values: if OIDC lives in a
  migrated `settings.json` and the chart enables neither OIDC nor forward-auth, it still renders
  native login `true` (and locks it). To keep the password form off, set
  `auth.native.enabled: false` and `auth.oidc.configuredInAdminUi: true`. The second value tells
  the chart that a sign-in method exists that it cannot see.
- **Upgrading from a preview chart (0.1.0-preview.1).** preview.1 always rendered
  `AUTH_NATIVE_LOGIN_ENABLED=true`, `FEATURE_DEVICE_AUTH=true`, `FEATURE_USER_PATS=false`,
  `ADMIN_GROUPS=admin` and (with forward-auth) `FORWARD_AUTH_GROUPS_ALWAYS_SENT=false`. The app
  defaults apply now. With forward-auth or OIDC, native login turns **off**: set
  `auth.native.enabled: true` to keep a password (break-glass) login.

- **Native login** or **OIDC** (`auth.oidc.*`): nothing else to do.
- **Forward-auth.** Set `auth.forwardAuth.enabled: true` (renders `FORWARD_AUTH_ENABLED=true`; the
  app ignores identity headers without it) and `auth.forwardAuth.*`, which controls the headers the app reads. Set
  `auth.forwardAuth.trustedProxyIps` to the pod CIDR of the router. The app ignores identity headers
  from any other peer. Exclude the node's CNI gateway (usually `.1` of the node's pod CIDR, e.g.
  `10.42.1.1`): kubelet probes and every `hostNetwork` process on the node arrive from it. Pinning
  the router to one node lets you list that node's pod CIDR minus `.0/.1`
  (`10.42.1.2/31,10.42.1.4/30,…,10.42.1.128/25`); the app warns when the list covers a gateway.

    That CIDR is in practice your whole pod network, so **`networkPolicy.enabled` is required**. With it,
    web accepts only the router and `networkPolicy.metricsFrom`, and those peers are as trusted as the
    router. The chart refuses to render forward-auth without it, unless you set
    `auth.forwardAuth.allowWithoutNetworkPolicy` because something else (a mesh, a CNI policy) restricts
    who reaches `web:3000`. Then either:
    - turn on `router.forwardAuth` (nginx `auth_request`; see `ci/gateway-values.yaml` for Authentik).
      `bypassPaths` (`/j/`, `/subsonic/`, `/oauth/`, `/api/plugin-webhooks/`, `/api/health`, `/metrics`) skip the IdP because the app authenticates those
      itself. `/api/v1/` tries the IdP and, on 401, passes through **without** identity, for PATs and
      device tokens. `/oauth/links/` (the account-linking callback) does the same
      (`oauthLinksPassthrough`), because it needs the signed-in user while the rest of `/oauth/` is
      the token-only device flow; keep `/oauth/links/` out of `bypassPaths`. `extraPassthroughPaths` adds more such prefixes; for example, `/api/playback/`
      for cookieless players fetching grant-carrying URLs. The app's user/group/name headers and
      `stripRequestHeaders` are blanked on every request, so clients can't forge them. https auth and
      outpost endpoints are TLS-verified (`sslVerify`, `caFile`).

        **Host header.** The auth subrequest (`router.forwardAuth.hostHeader`) and the outpost location
        (`router.forwardAuth.outpost.hostHeader`) send the endpoint's **own** host by default (the host
        of `url` / `outpost.origin`), and the app's host in `X-Forwarded-Host` and `X-Original-URL`.
        Authentik picks the application from `X-Forwarded-Host`, so this works both through a proxy
        that routes by Host (`https://auth.example.com/…`) and for an outpost Service reached directly.
        Set `$host` only for an endpoint that must see the app's host as Host. Behind a Host-routing
        proxy, `$host` sends the request back to Lumastra.

        **Auth endpoint errors.** nginx `auth_request` accepts only 2xx, 401 and 403 from the auth
        endpoint. Anything else would reach the client as a 500. The router treats a 3xx, 404, 5xx or
        timeout as 401 instead. A 404 happens, for example, when the IdP does not know the Host:
        in-cluster callers use `<release>.<ns>.svc.cluster.local`. On `/api/v1/` and
        `extraPassthroughPaths` the request goes to the app without identity, so Bearer tokens still
        work and a request without credentials gets the app's own 401. On `/` it gets the sign-in
        fallback (`signinUrl` redirect, else 401), never the app.
        We chose sign-in over a 502 so the same rule covers both cases: one code path, and a request
        without identity never reaches the app. The cost is that during an IdP outage, browsers are
        sent to a sign-in page that is also down. The router access log's `aus=` field shows the
        endpoint's real status, so you can tell an outage from a missing Host mapping.

    or

    - authenticate at your own edge. Then `router.forwardAuth.enabled=false` and the router passes the
      edge's headers through. Only do this if **nothing else** can reach the router.

## Network isolation

`networkPolicy.internal` defaults to **true**. It isolates the parts that never need traffic
from outside the release:

- the worker accepts only `networkPolicy.metricsFrom`;
- both bundled Valkeys accept only the web, worker and proxy pods;
- the proxy and sonic accept only the web and worker pods.

These policies use only the chart's own pod labels, so they work with any ingress controller.
With `serviceMonitor.enabled`, set `networkPolicy.metricsFrom` to your Prometheus pods. Otherwise
the worker policy would block the scrape, so the chart refuses to render.
For example, `ci/gateway-values.yaml` allows pods labeled
`app.kubernetes.io/name: prometheus` in the `monitoring` namespace. Set both selectors
to match your installation; putting them in the same peer requires both to match.

`networkPolicy.enabled` (the entry policies for the router and web) defaults to **false**, so
installs work with ingress controllers whose namespace and pod labels differ. By default, other
cluster pods can therefore reach `web:3000` directly. ClusterIP does not prevent this. Direct web requests bypass the router's header sanitization; with
`TRUSTED_PROXY_IPS` unset, forwarded client-IP headers can influence general IP rate-limit
buckets. Forward-auth identity headers require their separate opt-in and trusted-peer settings.

For isolation, enable policies and set **nonempty** `networkPolicy.ingressFrom` to your actual
ingress controller. For example, after checking the namespace and pod labels:

```yaml
networkPolicy:
    enabled: true
    ingressFrom:
        - namespaceSelector:
              matchLabels:
                  kubernetes.io/metadata.name: traefik
          podSelector:
              matchLabels:
                  app.kubernetes.io/name: traefik
```

The two selectors in one peer require both namespace **and** pod labels to match. Adapt them
for your controller; this chart does not install it. Empty `ingressFrom` keeps the entry port
open to **all sources**, even with policies enabled. With the router enabled, web accepts the
router and `metricsFrom`; without it, web itself is the entry point. Metrics peers reach all
of port 3000, not just `/metrics`. Bundled Valkey accepts app pods and the enabled stream
proxy. PostgreSQL needs its own isolation policy; this chart does not create one for it.

A pod that reaches `web:3000` directly cannot choose its client address: the app believes
`X-Forwarded-For` only with the router's hop secret (see "Routing"), and the strict client IP (login
and token rate limits, PAT and service-token IP allowlists, playback grants) stays the real peer
otherwise. It can still send `X-Forwarded-For` for the app's non-strict client IP (general rate
limits). With `networkPolicy.enabled` only the router and `networkPolicy.metricsFrom` reach web at
all.

Do not put a pod CIDR into `TRUSTED_PROXY_IPS`: that list also decides whose forward-auth identity
headers are believed. Use `auth.forwardAuth.trustedProxyIps` for forward-auth, and avoid trusting a
whole pod CIDR without isolation. Verify your CNI enforces NetworkPolicy and test
both ingress access and rejection from an unrelated pod; node/host-network traffic can have
CNI-specific behavior. Chart policies leave egress open.

## Integrations

`integrations.<name>` holds `url`, `publicUrl` and `apiKey` for Audiobookshelf, Kavita, Jellyfin,
Seerr, Sonarr and Radarr:

- **`url`** is what the app's server calls. An in-cluster Service URL is fine, e.g.
  `http://audiobookshelf.audiobookshelf.svc.cluster.local:13378`. A NetworkPolicy on the target
  side must allow this namespace.
- **`publicUrl`** is what browsers and apps are sent to (links, players). It must be reachable by
  users (`PUBLIC_AUDIOBOOKURL`, `PUBLIC_KAVITAURL`, `PUBLIC_JELLYFINURL`, `PUBLIC_REQUESTURL`).
- **`apiKey`** is `{secret, key}`, read from a Secret. `secret` defaults to `secrets.existingSecret`.

Other integrations (TMDB, MDBList, OpenAI, …) go in `secrets.env` (keys) and `app.env` (plain
values).

## Configuration precedence (migrating an existing install)

Settings resolve as **environment variable > `/config/settings.json` (Admin UI) > built-in
default**.

- A non-empty env value from the chart always wins, and the Admin UI won't save over it.
- A value that is **only** in `settings.json` stays active when the chart does not set that
  variable. That includes a URL or flag saved in the Admin UI of the old install.
- An **empty** env value does not clear it.

When you copy `/config` from an old install, review **Admin → Settings**, or `settings.json`
itself, for entries that no longer apply (old integration URLs, Jellyfin settings, feature
flags). Revert or delete them there.

## Storage

`accessModes: []` (the default) asks for `ReadWriteMany`. The web pods and worker
mount shared volumes at the same
time, usually on different nodes, so the default needs a `ReadWriteMany` storage class. A
`ReadWriteOnce` volume works there only when every pod that mounts it runs on the same node
(`global.nodeSelector` or affinity). Set `accessModes: [ReadWriteOnce]` on the volume then.

| Volume                                    | Mounted on                              | Default access mode | `ReadWriteOnce` is OK when              | Notes                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------- | --------------------------------------- | ------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persistence.config` → `/config`          | web, worker                             | RWX                 | all web + worker pods on one node       | settings.json, artwork, trickplay, caches. Required: both web and worker mount it.                                                                                                                                                                                                                                   |
| `persistence.transcode` → `/transcode`    | web, worker                             | RWX                 | all web + worker pods on one node       | One **shared** volume, so a pod that takes a session over serves already-written segments. `type: emptyDir` needs no storage class: each pod then has its own, and FFmpeg restarts on takeover.                                                                                                                      |
| `persistence.plugins` → `/app/plugins`    | web, worker                             | RWX                 | all web + worker pods on one node       | Installed external plugins. `enabled: false` uses an `emptyDir` per pod: installed plugins are lost on restart.                                                                                                                                                                                                      |
| `persistence.appCache` → `/app/.cache`    | web, worker                             | RWX                 | all web + worker pods on one node       | Rebuildable caches: artwork, extracted subtitles, library backdrops. `enabled: auto` (default) leaves it off. Turn it on when you have RWX storage or one node: off means an `emptyDir` per pod, emptied on every restart and not shared, so artwork is fetched and subtitles are extracted again after each deploy. |
| `persistence.ffmpegCache` → `/config/bin` | web, worker read-write, proxy read-only | RWX                 | all those pods on one node              | Off by default. Needed when the proxy is on; otherwise the cache lives in `/config`.                                                                                                                                                                                                                                 |
| `valkey.tasks.persistence` → `/data`      | the tasks Valkey (one pod)              | RWO                 | always                                  | AOF data. `enabled: false` uses an `emptyDir` (task keys lost on restart).                                                                                                                                                                                                                                           |
| `sonic.persistence`                       | sonic (one pod)                         | RWO                 | always                                  | The downloaded model.                                                                                                                                                                                                                                                                                                |
| `libraries[]`                             | web, worker, sonic if `music: true`     | your volume         | every pod that mounts it is on one node | `hostPath`, `existingClaim` or `nfs`. Read-only unless `app.metadataStorageLocation` is `alongside*`; override per component with `readOnly: {web, worker}`. The web pods need the libraries too: direct play and transcoding read the files there. A `hostPath` only works on the node that has the path.           |

Every chart-created PVC gets `persistence.dataAnnotations`, plus `helm.sh/resource-policy: keep`
(Helm only; Argo CD ignores it, so use `dataAnnotations` for Argo's
`Prune=false,Delete=false`). Set `existingClaim` to bring your own.

## Database

PostgreSQL **17+** with `vector`, `pg_trgm`, `pgcrypto` and `unaccent`. Migrations run inside the
web and worker pods at startup, under an advisory lock, so no Job or init container is involved.

- **External** (default): `DATABASE_URL` comes from `database.external.existingSecret`, or from
  `secrets.existingSecret` if that is unset. If the app's role is not a superuser, create the
  extensions once as a superuser; pgvector is not a trusted extension, so the role cannot create
  it itself. App images from 2026-10-01 on skip the base schema's `COMMENT ON EXTENSION` when the
  role doesn't own the extension. Older images also need the ownership hand-over (the `UPDATE`
  below; it edits the catalog directly, so skip it on current images):
    ```sql
    -- as a superuser, in the app database
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
    UPDATE pg_catalog.pg_extension SET extowner = 'lumastra'::regrole
     WHERE extname IN ('vector', 'pg_trgm', 'pgcrypto', 'unaccent');
    ```
- **CloudNativePG** (`database.mode: cnpg`, the operator must be installed): renders a `Cluster`
  with a non-superuser owner. `postInitApplicationSQL` creates the extensions
  (`database.cnpg.transferExtensionOwnership: true` adds the hand-over for older images). The app
  pods restart a few times while the Cluster bootstraps (about 1 min); that is expected. Optionally:
    - a `managed.roles` entry for `sonic_reader`;
    - Barman Cloud plugin backups (`ObjectStore` + `ScheduledBackup`; needs the plugin installed).

    The app reads `DATABASE_URL` from the operator's `<cluster>-app` Secret (`uri`).

### Locale and collation (CNPG)

CNPG initialises the database with locale `C` unless told otherwise. That is fine for a new
install, but **migrating** an existing database into a `C` cluster changes `ORDER BY` on text
(case and accents sort differently) and the default text search configuration. Check the source
before the first sync — `database.cnpg.initdb` is applied at bootstrap only:

```sql
SHOW server_encoding; SHOW lc_collate; SHOW lc_ctype; SHOW default_text_search_config;
SELECT datlocprovider, datcollate, datctype, datlocale FROM pg_database WHERE datname = current_database();
-- datlocprovider: c = libc, i = ICU (datlocale / daticulocale on PG < 17), b = builtin
```

```yaml
database:
    cnpg:
        # libc source (the usual Docker postgres image: en_US.utf8)
        initdb: { encoding: UTF8, localeCollate: en_US.utf8, localeCType: en_US.utf8 }
        # ICU source instead: { localeProvider: icu, icuLocale: en-US, locale: en_US.utf8 }
        parameters: { default_text_search_config: pg_catalog.english }
```

`database.cnpg.parameters` defaults to the same Postgres settings as `docker-compose.example.yml`:
`shared_buffers: 512MB` and raised JIT thresholds (JIT made the library-browse queries 4-19x slower
on a production install). Keys you set are merged into these defaults. On a large node, raise
`shared_buffers` (for example to 2-3GB) together with the Postgres pod's memory.

Allowed keys: `encoding`, `locale`, `localeCollate`, `localeCType`, `localeProvider`
(`libc`/`icu`/`builtin`), `icuLocale`, `icuRules`, `builtinLocale`, `dataChecksums`,
`walSegmentSize`. The `*-standard-*` CNPG images ship the glibc locales; `minimal` images only
have `C`/`C.UTF-8`. Verify after bootstrap with the same `SELECT`. `database.cnpg.hibernate: true`
stops the instance pods and keeps the volume; `backup.instanceSidecarConfiguration` sets the
Barman sidecar's resources.

## Valkey

Bundled by default as two instances:

- **cache**: `allkeys-lru` under `valkey.cache.maxmemory`, no persistence.
- **tasks**: `noeviction`, **no memory cap**, AOF on a PVC. Never let BullMQ/lock keys be evicted.

Both instances are required; single-store mode is unsupported. The password comes from
`valkey.auth.passwordKey` (cache, and the tasks instance too unless `valkey.auth.taskPasswordKey`
names a separate Secret key, for example `TASK_CACHE_PASSWORD`; add the key to the Secret first).
Passwords are embedded into `redis://` URLs by the pod at start, from a Secret value the chart
cannot see, so they cannot be percent-encoded: use only letters, digits and `-._~` (hex).
The Live TV proxy gets `TASK_CACHE_URL` too (its cluster heartbeat).
`valkey.mode: external` requires both `CACHE_URL` and `TASK_CACHE_URL` in the Secret,
pointing to separate policy-appropriate stores.

Upgrading from a single-Valkey install: with `valkey.mode: bundled` the chart now creates both
instances, and nothing else needs to change. The new tasks instance starts empty; to carry queued jobs
over, import the old dump (next section). With `valkey.mode: external`, add `TASK_CACHE_URL` to the
Secret and point `CACHE_URL` at a second, disposable instance. Web and worker pods refuse to start
until both are set. If `TASK_CACHE_URL` is your existing Valkey and it has only ever saved RDB
snapshots, do NOT restart it with `--appendonly yes`: it would start empty and ignore `dump.rdb`.
First, on the running server: `REDISCLI_AUTH=<password> valkey-cli CONFIG SET appendonly yes` and
`CONFIG SET maxmemory-policy noeviction`; wait until `INFO persistence` shows
`aof_rewrite_in_progress:0` and `aof_last_bgrewrite_status:ok`; only then change its startup
flags to `--appendonly yes --maxmemory-policy noeviction` and restart. The app refuses to start
when the task Valkey is empty but Postgres still has in-flight task state, and when it is not
`noeviction` (override: `LUMASTRA_ALLOW_EVICTING_TASK_VALKEY=true`, not recommended); it warns when
AOF is off. Docker Compose steps:
https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys

Watch Together keeps its live state in the cache instance. Size the cache so it is not under constant
eviction pressure.

### Importing an RDB snapshot into the tasks Valkey

An existing install usually runs its tasks Valkey/Redis with RDB snapshots only. The chart's tasks
instance runs AOF, and an AOF server **ignores `dump.rdb`** at start; its first shutdown then
**overwrites the dump with an empty snapshot**. So never start the tasks instance on a copied
dump without the import. `valkey.tasks.rdbImport.enabled: true` adds an init container that runs
only when `/data/dump.rdb` exists and there is no complete AOF (no manifest in
`/data/appendonlydir`): it loads the dump with AOF off (loopback only), switches AOF on (which
rewrites the loaded keys into `appendonlydir`), shuts down, and renames the dump to
`dump.rdb.imported-<UTC time>`. Otherwise it is a no-op, so it can stay on. The import never
writes the dump; on any failure (timeout `rdbImport.timeoutSeconds`, OOM, unreadable dump) it
removes the partial `appendonlydir` and exits non-zero, so the pod stays in `Init:` and retries
the import instead of starting an empty instance.

1. Sync with `valkey.tasks.replicas: 0` and `rdbImport.enabled: true` (the PVC is created, no pod).
   Keep the worker and web at 0 too.
2. On the source: `valkey-cli SAVE` (or `redis-cli`), then stop writers.
3. Copy `dump.rdb` into the root of the tasks PVC, owned by UID 1000 (e.g. a helper pod mounting
   the claim: `kubectl cp` + `chown 1000:1000`, or `rsync --chown=1000:1000`). The PVC must contain
   **no** `appendonlydir` — delete it if a tasks pod ever started on this claim.
4. Set `valkey.tasks.replicas: 1`. The `rdb-import` log shows the loaded keyspace (`db0:keys=…`) and `done`; compare it
   with `INFO keyspace` on the source and in the running pod (keys with a TTL may expire meanwhile).
5. Start worker and web.

Valkey loads RDB files from Valkey and from Redis up to 7.2. A newer Redis RDB format may not
load: the init container then fails (pod in `Init:Error`) and leaves the dump untouched.

## Optional components

- **Live TV proxy** (`proxy.enabled`, plus `features.FEATURE_LIVETV: true`). Needs
  `STREAM_PROXY_SECRET` in the Secret.
    - It mounts the shared ffmpeg cache read-only and re-checks for the binary every 5 s, so it
      picks ffmpeg up once a web or worker pod has filled the cache. For images built before
      2026-10-01 (boot-time check only), set `proxy.waitForFfmpegSeconds` (e.g. 600) to make an
      init container wait for it.
    - Give it its own `proxy.image.tag`/`digest`: a proxy restart drops every live channel, so don't
      tie it to app releases. Release images are tagged `X.Y.Z` (from git tag `vX.Y.Z`, e.g.
      `0.1.0`); a digest pins the exact build.
    - On shutdown it waits up to `proxy.drainSeconds` for `activeChannels` to reach 0.
- **Sonic** (`sonic.enabled`). amd64 only; the model downloads into its PVC on first start, so its
  `startupProbe` allows ~6 min.
    - It reads the DB as `sonic_reader` (`SELECT` on `media_audio_embeddings` only). An init container
      connects as the app role and grants that once the app has created the table. To do it by hand
      instead (`sonic.database.grant.enabled: false`):
        ```sql
        CREATE ROLE sonic_reader LOGIN PASSWORD '<hex>';
        GRANT CONNECT ON DATABASE lumastra TO sonic_reader;
        GRANT USAGE ON SCHEMA public TO sonic_reader;
        GRANT SELECT ON media_audio_embeddings TO sonic_reader;
        ```
- **GPU.** Two modes:
    - `gpu.mode: resource` with `gpu.resources` (e.g. `gpu.intel.com/i915: 1`, via a device plugin);
    - `gpu.mode: hostPath` (`/dev/dri`, usually needs `gpu.privileged: true`).

    Also set `gpu.renderGroupId` (the host's `render` GID), `gpu.acceleration` and `gpu.env`
    (`QSV_DEVICE`, `VAAPI_DEVICE`, `NVENC_*`, `TRICKPLAY_HWACCEL*`). `gpu.components` picks the pods.

    Some NVIDIA clusters run GPU pods under a separate runtime class (the NVIDIA GPU Operator
    creates `nvidia`). Set `web.runtimeClassName`, `worker.runtimeClassName`,
    or `proxy.runtimeClassName` to it for the pods that use the GPU.
    Unset by default; Intel and AMD device plugins do not need it.

## GitOps notes

- Pods roll when the rendered env or router config changes. They do **not** roll when a referenced
  Secret's content changes: restart them yourself, or use a tool such as Reloader.

- Output is deterministic. No `lookup`, no random values, no Helm hooks. Pods roll on changes via a
  hash of the rendered env/router config.
- Every image block takes `registry`, `repository`, `tag` and `digest` (digest wins), and
  `global.imageRegistry` overrides every registry (for mirrors). With the moving `stable` tag a
  `helm upgrade` renders the same pod spec and nothing rolls: pin a digest or release tag. Without
  a digest, moving tags (`stable`, `latest`, `main`) default to `pullPolicy: Always`.
- `ingress.className: nginx` adds the ingress-nginx body-size, buffering and timeout annotations
  (`ingress.nginxDefaults`); your own annotations win.
- `accessModes: []` (the default) means ReadWriteMany
  (see "Storage").
- Scheduling: `global.nodeSelector`/`tolerations`/`affinity` plus the same keys per component.

## Stopping components (maintenance, data moves)

Every workload has its own replica count, and `0` stops it while Services, PVCs and the CNPG
Cluster stay: `web.replicas`, `worker.replicas`, `router.replicas`,
`proxy.replicas`, `sonic.replicas`, `valkey.cache.replicas`, `valkey.tasks.replicas`.
The single-instance components (worker, proxy, sonic, both
Valkeys) accept only `0` or `1`: multiple executing workers are unsupported, and a second
Valkey/sonic/proxy pod would be an independent instance. `database.cnpg.hibernate: true`
hibernates the database. `ci/stopped-values.yaml` stops everything; `ci/migration-values.yaml` is
the starting point for moving an install in (app at 0, locale, RDB import).

Moving an existing install in: keep **worker and web at 0 until the database restore is done** —
either one migrates an empty database at startup, and the restore then collides with that schema.

## Sizing (web memory)

`web.resources.limits.memory` covers the pod's FFmpeg children too, and the limit is per pod.
Measured on Lumastra prod and a k3s rehearsal (2026-10-01):

| Load                                | Memory                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| web process without transcodes      | budget ~1.5 GiB (not measured on its own)              |
| each CPU transcode (libx264, 1080p) | **~1 GiB** (3 jobs OOM-killed a pod at 4 Gi)           |
| GPU transcodes (QSV)                | small: a QSV prod web pod peaked at 1.4 GiB in 30 days |

Plan **limit ≈ 1.5 GiB + 1 GiB × concurrent CPU transcodes per pod** (4K/HEVC sources need more).
The app's cap `LUMASTRA_MAX_CONCURRENT_TRANSCODES` is per pod and defaults to 3 × CPU cores
(12–32), far above what a 4 Gi pod survives without a GPU; set it (in `concurrency`) to match the
limit. `ci/cpu-only-values.yaml` is a CPU-only example. If a GPU install may fall back to CPU
(device plugin slots exhausted, GPU moved), size for the CPU case. The worker (thumbnails,
trickplay, audio analysis) follows the same rule for its own FFmpeg jobs.

## Shutdown behaviour (and known limits)

Web pods first sleep `web.preStopSleepSeconds` (15 s) in `preStop`, which gives endpoints and the
router time to drop them; set it to at least `router.dnsValid` plus your DNS TTL. Then SIGTERM
arrives and the app drains: `/api/health/ready` answers 503, the listener closes, any request that
still arrives answers `503 shutting_down` with `Retry-After: 2`, open event streams end (browsers
reconnect to another pod), and requests already running finish (for up to `web.drainSeconds`,
30 s; longer downloads are cut then). Only then
does it persist running transcodes so another pod can take them over, and close its database and
Valkey pools. The chart refuses a `web.terminationGracePeriodSeconds` below
`preStopSleepSeconds + drainSeconds + 30`. During a web rollout, pods update one at a time, highest ordinal first. A session whose pod is replaced
moves to another pod, waits there through one 503/retry cycle (≤ 15 s, ~10 s measured), and moves
back once the pod returns, which costs no further 503s.

Web is a StatefulSet, which has some consequences for operations:

- **Updates and drains are serial.** Pods are replaced one at a time, highest ordinal first,
  waiting `web.minReadySeconds` between them, with no surge, so capacity is N-1 during a rollout.
  `pdb.minAvailable: 1` also serialises node drains. A drained pod comes back under the same name,
  so the router's hash ring doesn't change.
- **A stuck rollout needs a manual step.** A pod that never becomes Ready (bad image, broken
  config) stalls the rollout, and a `helm rollback` or Argo sync does not replace it on its own.
  Run `kubectl delete pod <release>-web-N` after fixing the values. Argo CD shows the StatefulSet as
  Progressing.
- **Stable names help HLS.** A restarted `web-N` keeps its `HOSTNAME`, which is the HLS job owner,
  so it reclaims its sessions without the 15 s wait. Force-deleting a pod (`--force`) voids the
  one-pod-per-name guarantee that relies on.
- **Scale through `web.replicas`** (`helm upgrade`, or your GitOps values). The router renders
  one upstream line per slot, `max(web.replicas, router.webSlots)`. `kubectl scale statefulset`
  past that count adds pods that get **no traffic**, and the next sync scales them back.
- **HPA:** set `router.webSlots` to its `maxReplicas` as headroom, and keep `maxReplicas` ≤
  `router.webSlots`.

The dedicated worker serves liveness at `/api/health` and readiness at
`/api/health/ready`. Readiness drops during startup, upgrade preparation and
shutdown. Recreate prevents ordinary rolling overlap, but one replica alone is
not a safe ownership fence: planned upgrades must prepare, drain or postpone,
observe old-process termination and then start the replacement. Coordinate the
supervisor/controller before a guarded self-stop. See the
[upgrade procedure](https://lumastra.org/guides/task-troubleshooting/#preparing-a-dedicated-worker-for-an-upgrade).

## Validation

`ci/validate.sh` runs:

- `helm lint --strict` on every `ci/*-values.yaml` profile;
- `helm template | kubeconform -strict`, with the Gateway API, CNPG and Prometheus CRDs from the
  datree catalog;
- a determinism check (two renders must be identical);
- the `helm unittest` suites in `tests/`.
