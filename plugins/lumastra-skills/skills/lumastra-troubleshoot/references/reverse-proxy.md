# Reverse proxy

The full guide with working setups for Caddy, nginx, Traefik and Nginx Proxy Manager
is https://lumastra.org/guides/reverse-proxy/. Read the section for the proxy the
person runs before you propose a change.

## Find the setup first

- Where the proxy runs: as a container on the compose network (it reaches Lumastra at
  `lumastra:3000`) or on the host (it reaches `127.0.0.1:3000` through the published
  port).
- Its configuration, read-only: the `Caddyfile`, the nginx `server` block for the
  domain (`sudo nginx -T` prints the whole configuration), the Traefik labels on the
  `lumastra` service and Traefik's own `command:` or static config, or the proxy host
  in Nginx Proxy Manager.
- The Lumastra side: `ORIGIN`, `TRUSTED_PROXY_IPS` and `BODY_SIZE_LIMIT`, read as in
  [health-checks.md](health-checks.md#5-settings-without-printing-secrets).

Signed in as admin, **Admin → Fix → Logins fail or everyone looks logged out**
(`/admin/fix/proxy`) shows what the proxy sends on that very request: forwarded
headers, the peer address Lumastra sees, and whether it is trusted. Header values are
shown as presence and length only.

## Checklist

Check each line against the configuration.

- [ ] Upstream is plain `http://` on port 3000.
- [ ] `Host` passes through; `X-Forwarded-For` and `X-Forwarded-Proto` are set.
- [ ] No response buffering. Live updates use Server-Sent Events; video is HLS
      segments and byte ranges. WebSockets are not needed.
- [ ] Long read timeouts, an hour or more. Streams and event connections stay open
      for hours, and a transcode can take a while to produce its first segment.
- [ ] Request bodies of at least 50 MB, the `BODY_SIZE_LIMIT` in the example compose
      file and the image. nginx defaults to 1 MB. The app's own limits are 10 MB for
      artwork, 2 MiB for avatars and 3 MiB for diagnostics bundles from the Apple apps.
- [ ] No compression of media or `text/event-stream`.
- [ ] `ORIGIN` in `.env` is set (required behind a proxy) to the exact public address:
      scheme and host, plus the port only if it isn't 443.
- [ ] `TRUSTED_PROXY_IPS` holds the address Lumastra sees the proxy connect from. It is
      a comma-separated list of IP addresses and IPv4 CIDR ranges; list IPv6 proxies as
      single addresses. It lists proxies only, no LAN range, and every proxy in a chain
      (or the inner proxy alone when it restores the client address, e.g. nginx
      `real_ip_header CF-Connecting-IP` behind Cloudflare).

For nginx, the lines that matter are `client_max_body_size 50m;`,
`proxy_http_version 1.1;`, `proxy_set_header Host $host;`,
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
`proxy_set_header X-Forwarded-Proto $scheme;`, `proxy_buffering off;`,
`proxy_read_timeout 1h;`, `proxy_send_timeout 1h;` and `send_timeout 1h;`. For Traefik,
large uploads on slow connections need
`--entrypoints.websecure.transport.respondingTimeouts.readTimeout=0`.

Every proxy must also remove the sign-in headers `X-Forwarded-User`,
`X-Forwarded-Groups` and `X-Authentik-Name` from client requests (nginx
`proxy_set_header X-Forwarded-User "";`, Caddy `header_up -X-Forwarded-User`, a Traefik
headers middleware with an empty value, NPM `more_clear_input_headers`). Lumastra
believes them from any address in `TRUSTED_PROXY_IPS` once forward auth is on
(`FORWARD_AUTH_ENABLED=true`; off by default, then they are ignored).
Test it: `curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-User: admin' https://<domain>/api/user/profile`
must print `401`. A `200` means anyone can sign in as anyone; tell the person at once.

## Which address does Lumastra see?

Lumastra checks the TCP peer of each connection.

- Proxy on the host, through the published port: the peer is the gateway of the
  compose network (for example `172.21.0.1`), never `127.0.0.1`. Find it with
  `docker inspect $(docker compose ps -q lumastra) -f '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}'`.
  Trusting the gateway trusts every process on the host to send sign-in headers
  once forward auth is on. With a host proxy, leave `TRUSTED_PROXY_IPS` unset. For
  forward auth or real client IPs, the proxy belongs on the compose network with a fixed
  address (see https://lumastra.org/guides/deploy-docker/#reverse-proxy--tls).
- Proxy in a container: its address on the shared network. Find it with
  `docker inspect <proxy container> -f '{{range $n, $c := .NetworkSettings.Networks}}{{$n}}={{$c.IPAddress}} {{end}}'`.
  The address can change when the container is recreated.

## Symptoms

| Symptom                                                                             | Cause and fix                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 502 Bad Gateway                                                                     | The upstream uses `https://` or a port other than 3000; a containerized proxy points at `127.0.0.1` (that is the proxy container itself); a host proxy lost the `ports:` mapping; or `lumastra` is not healthy in `docker compose ps`.                                                                                            |
| Login fails with 403                                                                | `ORIGIN` doesn't match the address in the browser, or the proxy doesn't pass `Host`. The log shows `Blocked cross-site form submission (CSRF guard)` with the origin and host it compared, and the response body is `Cross-site POST form submissions are forbidden`. Compare scheme, host and port, then `docker compose up -d`. |
| Sign-in succeeds, then the sign-in page shows again                                 | The browser dropped the session cookie: it was `Secure` and the page is plain HTTP. Happens when `ORIGIN` is an `https` address and the person opens the same host over `http://` (a different host gets a 403 instead). Use the `https` address.                                                                                 |
| Playback stops after a pause or about a minute                                      | nginx closes a stream the player hasn't read for 60 seconds. Set `send_timeout 1h;` and `proxy_read_timeout 1h;`.                                                                                                                                                                                                                 |
| Live updates late or never                                                          | The proxy buffers or compresses event streams. In the browser's network tools the event stream should stay open and show `: ping` about every 10 seconds.                                                                                                                                                                         |
| Playback stops after about a minute                                                 | A read timeout is too short. nginx waits 60 seconds by default.                                                                                                                                                                                                                                                                   |
| Upload fails with 413                                                               | The proxy's body limit is below the upload. If the proxy allows it and the app still answers 413 with `Content-length of N exceeds limit of M bytes.`, `BODY_SIZE_LIMIT` is too small.                                                                                                                                            |
| Everyone shares one rate limit, or a token restricted with `allowed_ips` is refused | Lumastra sees only the proxy's address. Set `TRUSTED_PROXY_IPS`.                                                                                                                                                                                                                                                                  |
| Certificate error                                                                   | DNS doesn't point at the server yet, or ports 80 and 443 are blocked, so the certificate wasn't issued.                                                                                                                                                                                                                           |
| OIDC provider reports a redirect URI mismatch                                       | See [OIDC](common-causes.md#oidc): `ORIGIN` is missing, so Lumastra builds an `http://` callback.                                                                                                                                                                                                                                 |

After a change, check `curl -i https://<domain>/api/health` (HTTP 200,
`{"status":"pass"}`), then sign in in a browser.
