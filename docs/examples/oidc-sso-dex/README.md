# Lumastra + Dex — OIDC single sign-on example

A self-contained stack that runs **Lumastra** with a real **OpenID Connect**
provider ([Dex](https://dexidp.io/)) so you can try OIDC sign-in and the
OIDC-first onboarding flow end-to-end, in a browser, on one machine.

It's also the reference for wiring Lumastra to a real IdP (Authentik, Keycloak,
Authelia, Entra, Okta, …) — the Lumastra side is identical; only the issuer,
client id/secret and the groups claim change.

## What's in the box

| Service    | Image                              | Purpose                 |
| ---------- | ---------------------------------- | ----------------------- |
| `lumastra` | `ghcr.io/lumastra/lumastra:stable` | The app                 |
| `dex`      | `ghcr.io/dexidp/dex:v2.41.1`       | OIDC provider (the IdP) |
| `postgres` | `pgvector/pgvector:pg18`           | Database                |
| `valkey`   | `valkey/valkey:9-alpine`           | Cache                   |

## Quick start

```bash
cd docs/examples/oidc-sso-dex
cp .env.example .env
# generate the three secrets (compose refuses to start while they are empty)
for k in DB_PASSWORD CACHE_PASSWORD LUMASTRA_MASTER_KEY; do
  sed -i.bak "s/^$k=$/$k=$(openssl rand -hex 32)/" .env; done; rm -f .env.bak
docker compose up -d
# wait ~30–90s for the DB migrations on first boot
```

`.env.example` ships **no** secret values on purpose — a master key copied from a public
file is one everyone knows. Keep the generated `.env` (and back up the `config` volume):
losing `LUMASTRA_MASTER_KEY` makes the secrets stored in the config unrecoverable.
The Dex client secret (`AUTH_OIDC_CLIENT_SECRET`, mirrored in `dex-config.yaml`) is a
fixed demo value; it only authenticates Lumastra to this throwaway local Dex.

Open <http://localhost:8080>. You're a fresh install, so you land on `/setup`.

### Test identities (Dex)

| Connector         | Credentials                          | Becomes   | Why                                                     |
| ----------------- | ------------------------------------ | --------- | ------------------------------------------------------- |
| **Mock admin**    | _(no prompt — fixed identity)_       | admin     | emits `groups: ["authors"]`, and `ADMIN_GROUPS=authors` |
| **Email** (alice) | `alice@example.com` / `alicepass123` | non-admin | Dex's local connector emits no groups                   |
| **Email** (bob)   | `bob@example.com` / `bobpass123`     | non-admin | same                                                    |

### Try it

1. **First-run admin via OIDC** — on `/setup`, click **Sign in with Dex** →
   **Mock admin** → Grant Access. You're onboarded as the first admin.
2. **Regular user** — sign out, go to `/login` → **Sign in with Dex** →
   **Email** → `alice` → Grant Access. Alice is provisioned as a non-admin.
3. **First-user guard** — wipe and retry (`docker compose down -v && docker compose up -d`),
   then onboard with **Email/alice** first: she's rejected with _"the first user
   must be in an admin group"_ (no account is created), because the local
   connector carries no admin group.

You can see the federated identities under **Admin → Users → Identities**.

## How the networking works (and why)

The OIDC **issuer URL must resolve to the same Dex** for two different callers:

- the **browser**, which gets redirected to Dex's authorize endpoint, and
- the **Lumastra container**, which does server-side discovery + token exchange.

This example guarantees that by giving Lumastra and Dex a **shared network
namespace** (`network_mode: "service:dex"` in the compose file), so
`http://localhost:5556/dex` means the same thing to both. Dex's published port
(`5556`) serves the browser; the shared namespace serves the container.

That also keeps the **session cookie** working. The OIDC sign-in steps are GET
requests, and on those Lumastra keeps the cookie `Secure` unless `ORIGIN` is an
`http://` address. Chrome and Firefox accept a `Secure` cookie on
`http://localhost`, but drop it on plain HTTP to any other host, so OIDC sign-in
would fail there. Hence this example sticks to `http://localhost`.

## Going to production / a real IdP

For anything beyond a local test:

1. **Serve over HTTPS.** Put Lumastra behind your reverse proxy (Caddy, Traefik,
   nginx…) terminating TLS, and set `ORIGIN=https://media.example.com` so
   Lumastra builds the `https://` callback URL and the session cookie is always
   `Secure`. You can then drop the
   shared-namespace trick and run Lumastra as a normal service — the issuer is a
   real public URL both the browser and the container can reach.
2. **Point at your real IdP.** Set `AUTH_OIDC_ISSUER`, `AUTH_OIDC_CLIENT_ID`,
   `AUTH_OIDC_CLIENT_SECRET` and `AUTH_OIDC_GROUPS_CLAIM` for your provider, and
   register `https://media.example.com/auth/oidc/callback` as a redirect URI.
3. **Remove `AUTH_OIDC_ALLOW_INSECURE`.** It disables TLS verification for all
   OIDC traffic and exists only for a plain-HTTP test IdP like Dex here.
4. **Map your admin group.** Put your account in a group listed in
   `ADMIN_GROUPS`; the first user to onboard via OIDC must be an admin.

See also [Single sign-on with OIDC](https://lumastra.org/guides/sso-oidc/) (identity model,
account-linking safety) and [Authentication](https://lumastra.org/guides/authentication/)
(all sign-in modes).
