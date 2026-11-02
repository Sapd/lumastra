# Example Kubernetes manifests

> **Use the Helm chart.** The chart in [`deploy/helm/lumastra/`](../helm/lumastra/README.md)
> is the recommended way to run Lumastra on Kubernetes (beta). It adds an affinity router
> that keeps HLS sessions on one web pod, optional CloudNativePG, Live TV and sonic
> components, and GitOps-friendly secret handling. The manifests in this directory are
> minimal examples. Guide: <https://lumastra.org/guides/deploy-kubernetes/>.

Starting-point manifests for running Lumastra on Kubernetes. They are **examples** —
adapt the storage classes, hostname, image tag, and ingress to your cluster. They are
not a supported product.

> Full walkthrough: the **Deploy on Kubernetes** guide at
> <https://lumastra.org/guides/deploy-kubernetes/>.

## Topology

The same image (`ghcr.io/lumastra/lumastra:stable`) runs every role; `WORKER_MODE` and the
start command select what a container does. Web pods are web-only. The dedicated
lean TypeScript worker runs existing tasks/plugins and supervises one credential-free
Rust watcher child in the same worker container (Rust watcher only). BullMQ and the two policy-distinct Valkeys remain unchanged.

| Role     | Manifest        | `WORKER_MODE` | Replicas                         |
| -------- | --------------- | ------------- | -------------------------------- |
| Web      | `web.yaml`      | `disabled`    | ≥ 1 — scale freely (HPA on CPU)  |
| Worker   | `worker.yaml`   | `enabled`     | **exactly 1** (do not scale)     |
| Postgres | `postgres.yaml` | —             | 1 (or use a managed DB)          |
| Valkey   | `valkey.yaml`   | —             | 2 instances (cache + task split) |

## Quick start

```bash
# 1. Create your Secret from the template (NOT committed — see .gitignore)
cp deploy/k8s/secret.example.yaml deploy/k8s/secret.yaml
$EDITOR deploy/k8s/secret.yaml          # fill in passwords + keys

# 2. Edit placeholders: storageClassName(s), hostname, image tag.
# 3. Apply
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/secret.yaml
kubectl apply -k deploy/k8s/            # everything in kustomization.yaml

# 4. First boot has no admin → open https://<your-host>/setup to create one
#    (built-in login is enabled via AUTH_NATIVE_LOGIN_ENABLED in configmap.yaml).
# 5. Admin → Library: add your library paths (subdirs of /data), then scan.
```

## Choices you need to make

| Concern       | Files                                              | Notes                                                                          |
| ------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Media**     | `media-block.yaml` _or_ `media-s3-mountpoint.yaml` | A normal PVC/NFS export, **or** an S3 bucket via the Mountpoint-S3 CSI driver. |
| **Ingress**   | `ingress-nginx.yaml` _or_ `gateway-traefik.yaml`   | nginx with cookie affinity, **or** Gateway API + Traefik + cert-manager.       |
| **`/config`** | `config-pvc.yaml`                                  | Shared **ReadWriteMany** volume — web + worker both read/write it.             |

Update `kustomization.yaml` if you swap a default for its alternative.

## Authentication

The shipped default is **built-in login** (`AUTH_NATIVE_LOGIN_ENABLED: 'true'` in
`configmap.yaml`, `TRUSTED_PROXY_IPS` commented out): `kubectl apply -k .` as-is gives you a
self-contained app that authenticates its own users at `/setup` / `/login`, and neither
`ingress-nginx.yaml` nor `gateway-traefik.yaml` needs to do anything auth-related — they are
plain L7 routers in front of it.

**If you switch to forward-auth instead** (uncommenting `FORWARD_AUTH_ENABLED` and
`TRUSTED_PROXY_IPS` to trust an identity proxy like Authentik/Authelia injecting
`USERHEADER`/`GROUPHEADER`; the app ignores those headers while `FORWARD_AUTH_ENABLED` is off), these two
example manifests do **not** add the authenticating step for you. `TRUSTED_PROXY_IPS` only
tells the app which peer to trust for identity headers **if they are present** — it does not
make anything perform authentication. Setting it without also wiring a real auth gate turns
`USERHEADER`/`GROUPHEADER` into headers any client can set on its own request. Concretely,
you must add, in front of `lumastra-web`, one of:

- **ingress-nginx**: an `nginx.ingress.kubernetes.io/auth-url` (+ `auth-signin`) annotation
  pointing at your identity proxy's `auth_request` endpoint.
- **Traefik Gateway API**: a `ForwardAuth` middleware attached to the `HTTPRoute`, calling
  your identity proxy before the request reaches `lumastra-web`.

Neither is included here because wiring one in by default would point at an Authentik/Authelia
deployment this example doesn't ship — a broken-by-default example for anyone using native
login instead. Set `TRUSTED_PROXY_IPS` to the CIDR/pod range of whatever you add as that
already-authenticating edge (your identity proxy or the ingress controller calling out to it),
never to the ingress controller alone unless it is itself performing the `auth_request`/
`ForwardAuth` check.

## Four things you must get right

1. **Sticky sessions (web tier only).** HLS transcode state lives on the web pod that
   started a session, so whatever fans out across the **multi-replica web** pods must pin
   each client to one pod — cookie affinity or source-IP hash, **never round-robin**. A
   non-owner pod answers `503` and takes the session over only after the owner has been idle
   for 15 s, so misrouting shows up as retry storms and stalls rather than errors.
   `ingress-nginx.yaml` does this with a cookie; for Traefik annotate the `lumastra-web`
   Service (see `web.yaml`). The single worker pod is unaffected.
2. **Shared RWX `/config`.** The worker writes artwork/trickplay that web pods serve, so
   `/config` must be `ReadWriteMany`. Without RWX, colocate the web and worker pods on one node and explicitly use
   `ReadWriteOnce` on the shared persistent volume.
3. **Don't evict task keys.** Keep the task/BullMQ Valkey on `noeviction` (the
   `lumastra-valkey-tasks` instance, `TASK_CACHE_URL`) — any eviction policy (`allkeys-*` or `volatile-*`)
   can drop run state or lock keys and double-run jobs. The cache instance
   (`lumastra-valkey-cache`, `CACHE_URL`) may evict. The tasks instance has no `--maxmemory`
   (a hard cap with `noeviction` means write errors); its container limit is the ceiling.

    Upgrading from manifests where `lumastra-valkey` was the cache: the cache instance is now
    `lumastra-valkey-cache`. Point `CACHE_URL` in your Secret at it, apply, then delete the old
    `lumastra-valkey` StatefulSet and Service (`kubectl -n lumastra delete sts,svc lumastra-valkey`).
    The tasks instance and its `data` PVC keep their name. Coming from one Valkey that already
    holds queued jobs, switch AOF on live before moving it under `lumastra-valkey-tasks`:
    https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys

4. **One worker.** Keep `worker.yaml` at `replicas: 1`; scale it vertically, not out.

Migrations need no init-container — every pod runs them at boot under a Postgres advisory
lock, so the first pod migrates while the rest wait.

## Media on object storage (S3 / Mountpoint) — file-ingest behavior

`media-s3-mountpoint.yaml` mounts an S3 bucket read-only. **Will new files be ingested?**

- **Instant watcher notifications: no.** Rust is the only watcher. Instant updates require native
  filesystem notifications (inotify on Linux). Mountpoint-S3 is a FUSE filesystem and doesn't emit inotify events, and files
  uploaded straight to the bucket bypass the mount entirely — so they aren't picked up
  _instantly_.
- **Scheduled scan: yes.** The `file-library-scan` task re-lists directories (readdir,
  which Mountpoint serves fresh) on a schedule (**hourly** by default) and ingests
  anything new. After a bulk upload you can trigger it immediately from **Admin → Library**
  instead of waiting. (Disable the periodic scan with `DISABLE_FILE_LIBRARY_SCAN=true`.)

So with object-storage media, treat ingest as **scan-driven**, not event-driven — and the
same applies to an **NFS/SMB share written by another host** (Linux inotify doesn't fire for
remote writes, so both watcher implementations miss them too). Instant watcher pickup only
happens on a volume **Lumastra writes itself** (a pod-local / block PVC). For any
externally-written share or bucket, drive ingest with scheduled scans or the delta API.

**Scaling note:** the scan `stat()`s every file each cycle. On Mountpoint's default
`metadata-ttl` that's a HEAD-per-file round-trip, so a large library makes every hourly
scan `O(files)` requests. `media-s3-mountpoint.yaml` sets `metadata-ttl indefinite` so
stats are served from the directory LIST; for big or busy libraries also drive **scoped**
scans from S3 event notifications (`POST /api/v1/tasks/file-library-scan/run` with
`{"input":{"libraryPathId":"…"}}` and a `tasks:run`-scoped token — the stable, documented
trigger) and raise the periodic interval. See the deploy guide's _Scaling object-storage
scans_.

## Storage without RWX

Keep web and worker as separate roles. If only RWO block storage is available,
pin every web and worker pod mounting `/config` to the same node and explicitly
set `ReadWriteOnce` on that shared persistent volume. Both roles need the same
master key and config/artwork files; an ephemeral `emptyDir` loses those files on
pod replacement. Use the Helm chart's shared-storage settings for this topology.

The worker exposes `/api/health` and `/api/health/ready` for liveness and
readiness. Planned upgrades use stop-before-start after preparation/drain; keep web
and the stream proxy running. Observe termination of the old worker before
starting its replacement. See the [worker upgrade procedure](https://lumastra.org/guides/task-troubleshooting/#preparing-a-dedicated-worker-for-an-upgrade).

## Hardening

Every manifest sets a pod `securityContext` (`runAsNonRoot: true`, `runAsUser: 1000`,
`fsGroup: 1000`, `seccompProfile: RuntimeDefault`) and a container `securityContext`
(`allowPrivilegeEscalation: false`, every Linux capability dropped,
`readOnlyRootFilesystem: true`), and `network-policy.yaml` adds default-deny-ingress
network segmentation for the namespace. If your cluster's default `seccompProfile` or
Pod Security Admission level already covers some of this, these are redundant, not
conflicting — safe to apply as-is.

**Upgrading an existing (unhardened) deployment:** the fixed `runAsUser`/`fsGroup`
(1000:1000) can differ from whatever uid the container previously ran as, and
`fsGroup` only fixes ownership on a volume's **next** mount, not retroactively on
files it already wrote. On an existing PVC (`lumastra-config`, the Postgres `data`
PVC, the `lumastra-valkey-tasks` `data` PVC), either `chown -R 1000:1000` the volume
once (e.g. from a throwaway pod mounting it) before rolling out these manifests, or
roll out to a **fresh** environment first to confirm the values before touching
production data.

**Why `readOnlyRootFilesystem: true` needed volume mounts added:** every path the
app (or Postgres/Valkey) writes to outside its main data volume now has an explicit
`emptyDir` (or, for `/config`, the existing PVC) mounted over it — a read-only root
filesystem otherwise turns any of these into an `EACCES` at first write, not at
container start, so the failure can be delayed until a feature is used:

| Container     | Writable path         | Volume                           | Notes                                                                                                                                                                                                                                       |
| ------------- | --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web           | `/config`             | `lumastra-config` PVC (existing) | Includes `/config/bin` (ffmpeg cache) and `/config/cache/*`.                                                                                                                                                                                |
| web           | `/app/.cache`         | `emptyDir`                       | Extracted-subtitle cache etc — safe to lose on restart, re-derived on demand.                                                                                                                                                               |
| web           | `/app/plugins`        | `emptyDir`                       | External-plugin install target. **`emptyDir` does NOT survive a pod restart** — if you use Admin → Plugins → Install external plugin, swap this for a PVC (mirror `config-pvc.yaml`) so installs persist.                                   |
| web           | `/tmp`                | `emptyDir`                       | HLS transcode segments (`FFMPEG_TRANSCODE_DIR`, default `/tmp/lumastra-transcode`) and other scratch space. Per pod: a takeover restarts FFmpeg. A shared RWX volume for `FFMPEG_TRANSCODE_DIR` lets it serve the segments already written. |
| worker        | `/config`             | `lumastra-config` PVC (existing) | Shared with web.                                                                                                                                                                                                                            |
| worker        | `/tmp`                | `emptyDir`                       | ffmpeg/analysis scratch space and private worker control sockets.                                                                                                                                                                           |
| postgres      | the Postgres data dir | `data` PVC (existing)            | —                                                                                                                                                                                                                                           |
| postgres      | `/var/run/postgresql` | `emptyDir`                       | Unix-socket directory.                                                                                                                                                                                                                      |
| postgres      | `/tmp`                | `emptyDir`                       | —                                                                                                                                                                                                                                           |
| valkey (both) | `/tmp`                | `emptyDir`                       | —                                                                                                                                                                                                                                           |
| valkey-tasks  | `/data`               | `data` PVC (existing)            | `appendonly yes` — the `lumastra-valkey-cache` instance runs with `--save ""` and has no data volume by design.                                                                                                                             |

This list was compiled by auditing the app's known write paths (config getters,
`docker-compose.example.yml`'s own volume list) — it has not been exercised against
a running cluster. After rolling out, watch pod events/logs for a permission error
(`EACCES`/`EROFS`) naming a path not in this table, mount that path too, and — if
it's a real gap — please open an issue so this list stays accurate. If you hit one
you can't quickly resolve, set that container's `readOnlyRootFilesystem: false` and
keep the rest of the hardening (that field is independent of the others).

**NetworkPolicy** (`network-policy.yaml`) denies all ingress in the namespace by
default, then allows: web pods to receive traffic on 3000 (from anywhere, since your
ingress controller may run in a different namespace — scope the `from:` down once
you know its labels, see the comments in the file), web/worker pods to reach
Postgres (5432), both Valkey instances (6379), DNS (53), and HTTPS (443) egress, and
Postgres/Valkey to accept connections only from web/worker pods. Postgres and both
Valkey instances also get a DNS-only egress allow-list — hardening against a
post-compromise exfiltration primitive (an attacker who already has code execution
inside one of those pods), not a gap reachable from outside; this manifest set ships
no backup/metrics/replication sidecar for either tier, so DNS is all either
legitimately needs outbound. Requires a NetworkPolicy-enforcing CNI (Calico, Cilium,
etc.) — some managed clusters' default CNI ignores NetworkPolicy objects entirely
without a paid add-on; check your provider's docs.

**Web ingress is open to all sources in this example.** Other cluster pods can reach
`web:3000` directly and bypass the ingress controller's header sanitization or forward-auth
step. With `TRUSTED_PROXY_IPS` unset, forwarded client-IP headers can influence general IP
rate-limit buckets. ClusterIP and the namespace default-deny policy do not close this hole:
NetworkPolicies are additive, and the web allow rule admits everyone.

Before relying on ingress-only access, replace that rule's omitted `from` with your actual
controller namespace **and** pod labels. The examples choose nginx by default and offer
Traefik as an alternative, but do not install either controller or determine its labels.
For a conventional ingress-nginx install, the commented peer in `network-policy.yaml`
shows the shape. For a conventional Traefik install, use:

```yaml
from:
    - namespaceSelector:
          matchLabels:
              kubernetes.io/metadata.name: traefik
      podSelector:
          matchLabels:
              app.kubernetes.io/name: traefik
```

Keep both selectors in the same list item (AND); separate list items allow either match
(OR). An empty `from: []` also permits all sources. Verify the real labels and your CNI's
node/host-network behavior, then check ingress access succeeds and an unrelated pod cannot
reach port 3000. Pin `TRUSTED_PROXY_IPS` to that trusted edge as well; enabling forward-auth
also requires the authenticating step described above.
