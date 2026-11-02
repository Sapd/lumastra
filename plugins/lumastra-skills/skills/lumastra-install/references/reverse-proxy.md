# Reverse proxy and HTTPS

The full guide with every setup is https://lumastra.org/guides/reverse-proxy/. Before you
change anything, read the guide's section for the proxy the person chose. If you can't
fetch the page, tell the person and ask them to open it; don't write proxy configuration
from memory. This file summarizes the steps for the install. Show the person each change
and wait for their approval before you apply it.

## Before you start

- **DNS.** Run `dig +short <domain>` (or `nslookup <domain>`) and ask the person whether
  the address is the server's public address. Don't look up the server's address through
  an outside service without asking. If the domain is behind a CDN such as Cloudflare,
  the addresses differ; ask the person how they set it up.
- **Ports 80 and 443** must reach the server from the internet for the certificate. For a
  new proxy, check that nothing on the host uses them yet: `ss -ltn` on Linux or
  `lsof -nP -iTCP -sTCP:LISTEN` on macOS. If something does, stop and ask.
- **Where the proxy runs.**
    - On the compose network (a container in the same `docker-compose.yml`, or on a
      Docker network shared with Lumastra): it connects to `lumastra:3000`. Once it works,
      remove the `ports:` block from the `lumastra` service.
    - On the host (nginx or Caddy installed as a system package): it connects to
      `127.0.0.1:3000`. Keep the `ports:` block with `127.0.0.1:3000:3000`.
- The proxy connects to Lumastra over plain `http://` on port 3000.

## What every proxy must do

- Pass `Host` through and set `X-Forwarded-For` and `X-Forwarded-Proto`.
- Remove the sign-in headers `X-Forwarded-User`, `X-Forwarded-Groups` and
  `X-Authentik-Name` from every request. With forward auth on (`FORWARD_AUTH_ENABLED=true`)
  Lumastra believes them from any address in `TRUSTED_PROXY_IPS`, so a proxy that passes a
  client's copy through lets anyone sign in as any user. With forward auth off Lumastra
  ignores them, but keep removing them so that turning it on later is safe. Every config
  below removes them; never drop those lines.
- Turn off response buffering. Live updates use Server-Sent Events; video is HLS
  segments and byte ranges. Lumastra uses no WebSockets.
- Allow timeouts of one hour in both directions. Streams and event connections stay open
  a long time, and a paused player stops reading (nginx: `send_timeout`).
- Accept request bodies of at least 50 MB (`BODY_SIZE_LIMIT` in the example compose
  file). nginx defaults to 1 MB.
- Don't compress media or `text/event-stream`.

## Traefik

The example compose file ships Traefik labels on the `lumastra` service that use an
Authentik middleware (`authentik@docker`). Replace all of those labels.

If the person already runs Traefik, find the names it uses before you write labels: the
Docker network it watches (`docker inspect <traefik container> -f '{{json .NetworkSettings.Networks}}'`),
and its entrypoint and certificate resolver names (in its `command:` arguments or its
`traefik.yml`). The example below uses `proxy`, `websecure` and `letsencrypt`; replace
them with those names, and `media.example.com` with the person's domain:

```yaml
services:
    lumastra:
        labels:
            - traefik.enable=true
            - traefik.docker.network=proxy
            - traefik.http.routers.lumastra.rule=Host(`media.example.com`)
            - traefik.http.routers.lumastra.entrypoints=websecure
            - traefik.http.routers.lumastra.tls=true
            - traefik.http.routers.lumastra.tls.certresolver=letsencrypt
            - traefik.http.routers.lumastra.middlewares=lumastra-headers
            # Lumastra reads sign-in headers from trusted proxies. Never pass a client's own.
            - traefik.http.middlewares.lumastra-headers.headers.customrequestheaders.X-Forwarded-User=
            - traefik.http.middlewares.lumastra-headers.headers.customrequestheaders.X-Forwarded-Groups=
            - traefik.http.middlewares.lumastra-headers.headers.customrequestheaders.X-Authentik-Name=
            - traefik.http.services.lumastra.loadbalancer.server.port=3000
        networks:
            - lumastra-network
            - proxy

networks:
    lumastra-network:
        driver: bridge
    proxy:
        external: true
```

Edit the existing `labels:` and `networks:` keys of the `lumastra` service and the
existing top-level `networks:` block. Don't add a second key of the same name.
`lumastra` must stay on `lumastra-network`, where PostgreSQL and Valkey are. Validate
with `docker compose config --quiet`.

If the person already uses a `lumastra-headers` middleware name, pick another name.

For a new Traefik, create the network once with a fixed subnet so Traefik can get a
fixed address:
`docker network create --subnet 172.30.0.0/24 --ip-range 172.30.0.128/25 proxy`.
Check first with `docker network inspect proxy` that it doesn't exist, and pick another
private range if `172.30.0.0/24` is in use. Use the minimal Traefik service from the
guide's Traefik tab, which pins Traefik to `172.30.0.2` on that network. The service needs
an email address for Let's Encrypt; ask the person for it. To stop Traefik from cutting
off large uploads on slow connections after 60 seconds, add
`--entrypoints.websecure.transport.respondingTimeouts.readTimeout=0` to the Traefik
service's `command:`.

## Caddy

Caddy issues certificates by itself. For Caddy in the same compose file, write a
`Caddyfile` next to `docker-compose.yml`:

```caddyfile
media.example.com {
    reverse_proxy lumastra:3000 {
        header_up -X-Forwarded-User
        header_up -X-Forwarded-Groups
        header_up -X-Authentik-Name
    }
}
```

Then add the `caddy` service with its fixed address, its `caddy_data` and `caddy_config`
volumes, and the subnet on `lumastra-network`. Copy all of it from the guide's Caddy tab.
For Caddy on the host, add the same block with `reverse_proxy 127.0.0.1:3000` to its
existing Caddyfile and reload it.

## nginx on the host

Use the complete `server` block from the guide's nginx tab. The required settings are
`client_max_body_size 50m`, `send_timeout 1h`, `proxy_http_version 1.1`, the three
forwarding `proxy_set_header` lines, the three lines that clear the sign-in headers,
`proxy_buffering off`, `proxy_read_timeout 1h` and `proxy_send_timeout 1h`. Get the
certificate before you add the file (`sudo certbot certonly --nginx -d <domain>`), because
nginx refuses to start with a missing certificate file. Keep `listen 443 ssl http2;` from
the guide: `http2 on;` fails on nginx older than 1.25.1, which includes Ubuntu 24.04 and
Debian 12. Check and reload with `sudo nginx -t && sudo systemctl reload nginx`.

## Nginx Proxy Manager

Follow the guide's Nginx Proxy Manager tab: give NPM its fixed address, forward to
`lumastra` port `3000` over `http`, turn off Cache Assets, request a certificate with
Force SSL, and paste the whole Advanced snippet, including the
`more_clear_input_headers` line.

## `.env` changes

Check first that neither line exists yet; this must print `0`:

```bash
grep -c -e '^ORIGIN=' -e '^TRUSTED_PROXY_IPS=' .env
```

If it prints another number, ask the person which values to keep. Otherwise add:

```dotenv
ORIGIN=https://media.example.com
```

`ORIGIN` is the exact public address: the scheme and host, plus the port if it is not 443. If it is set and the host or port doesn't match the browser's address, sign-in
fails with 403. It is required behind a proxy: without it, an app sign-in that sends no
`Origin` header, through an inner proxy that reports `http`, can get a session cookie
without `Secure`.

`TRUSTED_PROXY_IPS` lets Lumastra take the real client address from `X-Forwarded-For`.
On its own it signs nobody in: identity headers are read only with `FORWARD_AUTH_ENABLED=true`.
Without it, all clients behind the proxy share one rate-limit budget, which is fine for
a home server. Set it only when both are true: the proxy removes the sign-in headers
(every config above does), and the address belongs to the proxy alone. Never put a LAN
range such as `192.168.0.0/16` in it: every device in the range could choose its client
address and, with forward auth on, sign in as any user (the doctor warns about IPv4
ranges wider than `/24`). With a CDN or a second proxy in front (Cloudflare, then nginx),
let nginx restore the client address (`set_real_ip_from` with Cloudflare's ranges,
`real_ip_header CF-Connecting-IP`) instead of listing Cloudflare's ranges; see
https://lumastra.org/guides/reverse-proxy/#trusted_proxy_ips.

- Proxy in the same compose file (Caddy service, Traefik, NPM): add
  `TRUSTED_PROXY_IPS=<the proxy's fixed address>` from the guide, for example
  `172.30.0.2` for Traefik or `172.28.0.10` for Caddy or NPM.
- Proxy on the host (nginx or Caddy as a system package): leave `TRUSTED_PROXY_IPS`
  unset. Lumastra sees the proxy as the Docker network's gateway, and every program on
  the host connects from that same address. Trusting it lets any local program sign in
  as any user. Tell the person that rate limits are then shared.
- Docker Desktop on macOS or Windows: leave it unset as well.

Apply the changes with `docker compose up -d`.

## Check

```bash
curl -fsS https://media.example.com/api/health/ready
```

It must print `{"status":"pass"}`. HTML, or any other body, means the request did not
reach Lumastra: check the proxy's routing rule and middlewares.

Then check that the proxy removes the sign-in headers. This must print `401`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-User: admin' https://media.example.com/api/user/profile
```

A `200` means anyone can sign in as any user. Stop, tell the person, and fix the proxy
config before you continue.

If the proxy reaches Lumastra over the compose network, now remove the `ports:` block
from the `lumastra` service, run `docker compose up -d`, and run the check again. From
then on, `http://localhost:3000` no longer answers on the host. Check the app directly
with `docker compose exec lumastra curl -fsS http://localhost:3000/api/health/ready`.

Common failures:

- Certificate error: DNS doesn't point at the server yet, or ports 80 and 443 are
  blocked. Repeat the checks in "Before you start".
- 502 Bad Gateway: the proxy uses `https://` or a port other than 3000; a proxy in a
  container points at `127.0.0.1`, which is the proxy container itself; a proxy on the
  host lost the `ports:` mapping; or `lumastra` is not healthy in `docker compose ps`.
- Login fails with 403: `ORIGIN` doesn't match the address in the browser (a leftover
  `:3000` counts), or the proxy doesn't pass `Host`. Fix the one that differs and
  restart.
- 504 on Traefik: the `traefik.docker.network=proxy` label is missing.
- Playback stops after a pause or after about a minute: a timeout is too short. In nginx,
  raise `send_timeout` and `proxy_read_timeout` to one hour.
- Uploads fail with 413: the proxy's body limit is below 50 MB. Raise it.
