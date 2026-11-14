<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Lumastra Helm chart

Runs [Lumastra](https://lumastra.org), a self-hosted media server, on Kubernetes. The full guide
is at <https://lumastra.org/guides/deploy-kubernetes/>.

The chart deploys:

- **web**: the UI, API and video streaming. Two pods by default.
- **worker**: one pod for background tasks.
- **router**: an nginx pod that sends each video session to the same web pod.
- **two Valkey servers**: one for the task queue, one for the cache.

Optional: a Live TV proxy, a music-analysis sidecar and a CloudNativePG database.

## Before you start

You need:

- Kubernetes 1.29 or newer, `kubectl` and Helm 3.14 or newer. On k3s, copy
  `/etc/rancher/k3s/k3s.yaml` to `~/.kube/config` and `export KUBECONFIG=~/.kube/config`.
- PostgreSQL 17 or newer with the `vector` (pgvector), `pg_trgm`, `pgcrypto` and `unaccent`
  extensions. You can run your own, or let the chart create one with CloudNativePG
  (`database.mode: cnpg`).
- Storage. With several nodes, you need a `ReadWriteMany` storage class (for example NFS or
  CephFS). On one node, `ReadWriteOnce` is enough.
- A hostname, for example `lumastra.example.com`.

## Install on one node

One node, a CloudNativePG database and an Ingress. It works on a stock k3s (Traefik and
`local-path` storage included).

1. Get the chart.

    ```bash
    git clone --branch v0.1.4 https://github.com/Sapd/lumastra.git
    cd lumastra
    ```

2. Install the database operator. Do this once per cluster.

    ```bash
    helm repo add cnpg https://cloudnative-pg.github.io/charts
    helm upgrade --install cnpg cnpg/cloudnative-pg -n cnpg-system --create-namespace --wait
    ```

3. Create the namespace and a Secret.

    ```bash
    kubectl create namespace lumastra
    kubectl -n lumastra create secret generic lumastra \
      --from-literal=LUMASTRA_MASTER_KEY="$(openssl rand -hex 32)" \
      --from-literal=CACHE_PASSWORD="$(openssl rand -hex 24)"
    ```

    **Back up `LUMASTRA_MASTER_KEY`.** It encrypts the secrets Lumastra stores. Without it you
    cannot restore them.

4. Write `my-values.yaml`. Use your node name (`kubectl get nodes`), your media folder and your
   host name. Set `className` to `nginx` for ingress-nginx.

    ```yaml
    mode: split
    image:
        tag: 0.1.4
    app:
        origin: http://lumastra.example.com
    secrets:
        existingSecret: lumastra
    router:
        enabled: false
    web:
        replicas: 1
    global:
        nodeSelector:
            kubernetes.io/hostname: my-node
    database:
        mode: cnpg
    persistence:
        config: { accessModes: [ReadWriteOnce] }
        plugins: { accessModes: [ReadWriteOnce] }
        transcode: { type: emptyDir }
        appCache: { enabled: true, accessModes: [ReadWriteOnce] }
    libraries:
        - { name: media, mountPath: /data/media, hostPath: /srv/media }
    ingress:
        enabled: true
        className: traefik
        hosts: [{ host: lumastra.example.com }]
    ```

    To use your own PostgreSQL, remove the `database` block and add `DATABASE_URL` to the Secret.

5. Install.

    ```bash
    helm install lumastra deploy/helm/lumastra -n lumastra -f my-values.yaml
    kubectl -n lumastra get pods
    ```

    After one to three minutes, every pod should be `Running` and ready, including
    `lumastra-postgres-1`. The pods may restart a few times while the database starts.

6. Open <http://lumastra.example.com/setup> with your own host name. No DNS name yet? Add the
   node's address and the name to the hosts file of the computer you browse from.

    You should see the setup page. It lets you choose how people sign in and create the admin
    account. Then add your library path (`/data/media` above) under Admin, Library.

The Apple apps need HTTPS. Change `origin` to `https://`, add a `tls` entry as in the next
section, and run `helm upgrade`.

## Install on a cluster

Use this when pods run on several nodes. Steps 1 to 3 and 5 to 6 are the same as above. In
step 4, use this `my-values.yaml`. It needs a `ReadWriteMany` storage class and an ingress
controller.

```yaml
image:
    tag: 0.1.4
app:
    origin: https://lumastra.example.com
secrets:
    existingSecret: lumastra
database:
    mode: cnpg
persistence:
    config: { storageClassName: my-rwx-class }
    plugins: { storageClassName: my-rwx-class }
    transcode: { storageClassName: my-rwx-class }
    appCache: { enabled: true, storageClassName: my-rwx-class }
libraries:
    - { name: media, mountPath: /data/media, nfs: { server: 10.0.0.1, path: /export/media } }
ingress:
    enabled: true
    className: nginx
    hosts: [{ host: lumastra.example.com }]
    tls: [{ hosts: [lumastra.example.com], secretName: lumastra-tls }]
```

Every web pod needs the media libraries, so use a volume all nodes can mount. The router handles
video stickiness, so your ingress needs no session affinity. It must not buffer responses and
needs long timeouts. For `ingress.className: nginx` the chart sets these for you.

More example values (OIDC login, Gateway API, CloudNativePG, GPU) are in the
[`ci/`](ci/) folder.

## Important values

All values are in [`values.yaml`](values.yaml), with comments.

| Value                                 | What it does                                                          |
| ------------------------------------- | --------------------------------------------------------------------- |
| `app.origin`                          | The public URL. Sign-in cookies and form checks depend on it.         |
| `secrets.existingSecret`              | Name of your Secret. The chart never creates secrets.                 |
| `database.mode`                       | `external` (default) or `cnpg` for a CloudNativePG cluster.           |
| `libraries`                           | Media folders. Each one uses `hostPath`, `existingClaim` or `nfs`.    |
| `persistence.config.storageClassName` | Storage for `/config`. Same keys exist for `transcode` and `plugins`. |
| `persistence.config.accessModes`      | Empty means `ReadWriteMany`. Set `[ReadWriteOnce]` on a single node.  |
| `web.replicas`                        | Number of web pods. Above 1, keep `router.enabled: true`.             |
| `image.tag`, `image.digest`           | App version. Pin a release tag or a digest in production.             |
| `ingress`, `httpRoute`                | Expose the app with an Ingress or a Gateway API route.                |
| `gpu.mode`                            | `resource` or `hostPath` for hardware transcoding. Off by default.    |

## Upgrade

1. Read the [changelog](https://github.com/Sapd/lumastra/blob/main/CHANGELOG.md), then check
   out the new chart version.

    ```bash
    git fetch --tags && git checkout vX.Y.Z
    ```

2. Put the same version in `my-values.yaml`, so later upgrades keep it, and upgrade. The
   default image tag `stable` does not roll the pods by itself.

    ```bash
    sed -i.bak 's|^    tag: .*|    tag: X.Y.Z|' my-values.yaml && rm my-values.yaml.bak
    helm upgrade lumastra deploy/helm/lumastra -n lumastra -f my-values.yaml
    ```

The app pods update one at a time. The database schema updates when the first new pod starts.

## Uninstall

```bash
helm uninstall lumastra -n lumastra
```

Your data stays. The chart keeps its volumes (`persistence.keepOnUninstall: true`), and your
external database is not touched. A CloudNativePG cluster from `database.mode: cnpg` is removed
with the release, so back it up first. To delete the kept volumes:

```bash
kubectl -n lumastra delete pvc -l app.kubernetes.io/instance=lumastra
```

## Learn more

- [Deploy on Kubernetes](https://lumastra.org/guides/deploy-kubernetes/): the full guide
- [Source and issues](https://github.com/Sapd/lumastra)
- License: AGPL-3.0-only
