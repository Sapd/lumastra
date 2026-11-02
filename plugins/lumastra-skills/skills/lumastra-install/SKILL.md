---
name: lumastra-install
description: Use when someone asks to install, set up or deploy Lumastra, the self-hosted media server, on a machine they control. Guides a Docker Compose install from machine check to HTTPS behind a reverse proxy, and sends Kubernetes installs to the Helm chart guide. For an install that already runs and has a problem, use lumastra-troubleshoot.
---

# Install Lumastra

You are helping a person install Lumastra on a machine they control. Work through the
steps in order. Run commands yourself where you can, check each result before you go
on, and ask the person whenever a step needs a decision or information you can't check.
The human-readable guide is https://lumastra.org/start/quick-start/.

## Rules

- Never print, paste or log the generated secrets (`DATABASE_PASSWORD`, `CACHE_PASSWORD`,
  `LUMASTRA_MASTER_KEY`). Write them only into `.env`. Don't `cat .env`, run
  `docker compose config` without `--quiet`, or run `docker inspect` without a `-f`
  format that selects only the fields you need; all three print them. Before you show
  the person log or doctor output, replace any `://user:password@` part with `://***@`.
- Keep port 3000 off the internet. Keep the mapping `127.0.0.1:3000:3000`. Change it to
  `3000:3000` only when the person explicitly wants plain-HTTP access from their local
  network without a proxy; then leave `ORIGIN` unset and tell them that passwords cross
  the network unencrypted, that the iPhone, iPad and Apple TV apps need HTTPS, and never
  to forward port 3000 on their router. Remote access goes through a reverse proxy with
  HTTPS.
- Ask before you delete or overwrite any file, container, volume or network. This
  includes an existing `docker-compose.yml` or `.env` and existing Lumastra containers or
  volumes.
- The secrets file must be named exactly `.env`. Compose reads `${DATABASE_PASSWORD}` and
  the other variables from that file name only.
- Your shell may not keep its working directory between commands. Start every command
  with `cd <install folder> &&`.
- If something fails, show the person the relevant error lines and the fix you propose
  before you change anything.

## 1. Docker Compose or Kubernetes

Ask first. Docker Compose is the default and the steps below cover it. For Kubernetes,
stop here and follow https://lumastra.org/guides/deploy-kubernetes/ (Helm chart, beta).
Its "What you need" section lists what to ask the person.

## 2. Check the machine

Run the checks in [references/machine-check.md](references/machine-check.md) and report
each result. If Docker is missing, ask before installing it.

## 3. Ask the person

1. **Install folder.** Default `~/lumastra`.
2. **Media folders** (movies, series, music). They are mounted read-only.
3. **Reverse proxy and domain.** The iPhone, iPad and Apple TV apps only connect over
   HTTPS. Ask whether they already run a proxy (Traefik, Caddy, nginx, Nginx Proxy
   Manager) and whether it runs on the host or as a container; which domain to use and
   whether its DNS points at this server. With no proxy, offer Traefik with Docker labels
   or Caddy and let them choose. Skip the proxy only if they explicitly want local use.
4. **Sign-in.** Built-in accounts work out of the box. OIDC can be added later:
   https://lumastra.org/guides/authentication/. If they want forward auth, set
   `FORWARD_AUTH_ENABLED=true` in `.env` (off by default, nobody signs in through the proxy
   without it; it can only be set in the environment, Admin → Settings can't turn it on),
   and the proxy has to run on the compose network with a fixed address; tell them, and follow
   https://lumastra.org/guides/deploy-docker/#reverse-proxy--tls in step 8.
5. **TMDB credential** for movie and series metadata. Optional, strongly recommended,
   free: https://www.themoviedb.org/settings/api. Either the "API Key" or the "API Read
   Access Token" works.

## 4. Download the two files

Check for an earlier install first:

```bash
docker compose ls -a
docker volume ls --format '{{.Name}}' | grep -i lumastra
mkdir -p ~/lumastra && cd ~/lumastra && ls -A
```

If any of them shows Lumastra, or the folder already holds `docker-compose.yml` or
`.env`, stop and ask. Compose names the project after the folder, so a second folder
with the same name reuses the first install's volumes. Then download:

```bash
cd ~/lumastra && \
  curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Sapd/lumastra/main/docker-compose.example.yml && \
  curl -fsSL -o .env https://raw.githubusercontent.com/Sapd/lumastra/main/.env.example && \
  chmod 600 .env
```

Use the folder from question 1. You don't need to clone the repository.

## 5. Generate the secrets

Follow [references/secrets-and-env.md](references/secrets-and-env.md). It also adds the
TMDB credential and covers Windows.

## 6. Mount the media

Add one read-only line per media folder from question 2 to the existing `volumes:` list
of the `lumastra` service (the top-level `volumes:` block is a different list). Keep the
container paths under `/data/media/`, and quote a line whose host path has spaces:

```yaml
services:
    lumastra:
        volumes:
            # existing entries stay as they are
            - /srv/media/movies:/data/media/movies:ro
            - '/srv/media/tv shows:/data/media/series:ro'
```

The host folders must exist and be readable by uid 1000, which the container runs as.
Docker creates a missing folder as an empty root-owned one. On Fedora or RHEL with
SELinux, use `:ro,z`. On Docker Desktop, the folders must be in the file sharing list.
Validate with `docker compose config --quiet`; no output means valid.

## 7. Start and verify

```bash
cd ~/lumastra && docker compose up -d --wait --wait-timeout 600
```

`--wait` returns once every container is healthy. The first start pulls the images and
runs the database migrations, which can take several minutes. If `--wait` reports an
unhealthy or timed-out container, read `docker compose logs --tail=200 lumastra`; while
the log still shows migration progress, run the same command again. Then check:

```bash
cd ~/lumastra && \
  curl -fsS http://localhost:3000/api/health/ready && \
  docker compose logs lumastra | grep -c 'Schema migration completed successfully' && \
  docker compose exec lumastra ls /data/media
```

The ready check must print `{"status":"pass"}`; it also checks PostgreSQL and Valkey. The
`grep` must print at least `1`, and the last command must list the media folders. If
something fails, run `docker compose ps` and `docker compose exec lumastra npm run doctor`
and show the person the result (with connection strings masked).

## 8. Reverse proxy and HTTPS

Do this by default with the answers to question 3. Follow
[references/reverse-proxy.md](references/reverse-proxy.md), and show the person every
change to `docker-compose.yml` and `.env` before you apply it.

## 9. Finish

Until the first admin account exists, anyone who can open the address can create it.
Tell the person to open `https://<domain>/setup` as soon as the proxy works, create the
admin account and add the libraries under `/data/media/...`. Without a proxy, they open
`http://localhost:3000/setup` on that machine, or through an SSH tunnel from their own
computer: `ssh -L 3000:127.0.0.1:3000 <user>@<server>`. With the mapping `3000:3000` for
local-network access they open `http://<server-ip>:3000/setup`. You can't do this step
for them.

Summarize for the person: the install folder, the mounted media folders, the proxy and
domain, the URL to open, and these points:

- Back up `LUMASTRA_MASTER_KEY` from `.env` outside the server. Without it, the secrets
  Lumastra stores can't be decrypted.
- Backups: https://lumastra.org/guides/backup-recovery/
- Known limitations: https://lumastra.org/reference/known-limitations/
- Updating: back up first, then run `docker compose pull && docker compose up -d` in the
  install folder. New versions migrate the database on start, and an older image can't
  undo that.
