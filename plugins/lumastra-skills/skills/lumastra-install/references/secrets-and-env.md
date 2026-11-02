# Secrets and .env

Run every command in the install folder (start each one with `cd <install folder> &&`).
None of these commands prints a secret. At no point run `cat .env`, `grep` without `-c`
on `.env`, or `docker compose config` without `--quiet`; each of them prints the
secrets.

## 1. Check that `.env` still holds the placeholders

```bash
grep -c -e '^DATABASE_PASSWORD=$' -e '^CACHE_PASSWORD=$' -e '^# LUMASTRA_MASTER_KEY=$' .env
```

This must print `3`. If it prints another number, `.env` holds values other than the
empty placeholders, for example from an earlier install. Stop and ask the person. Replacing
`DATABASE_PASSWORD` or `LUMASTRA_MASTER_KEY` on an existing database locks Lumastra out
of its data.

## 2. Generate the secrets (Linux and macOS)

```bash
(
  hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
  db=$(hex 24); cache=$(hex 24); key=$(hex 32)
  if [ ${#db} -eq 48 ] && [ ${#cache} -eq 48 ] && [ ${#key} -eq 64 ]; then
    sed -i.bak \
      -e "s|^DATABASE_PASSWORD=.*|DATABASE_PASSWORD=$db|" \
      -e "s|^CACHE_PASSWORD=.*|CACHE_PASSWORD=$cache|" \
      -e "s|^# LUMASTRA_MASTER_KEY=.*|LUMASTRA_MASTER_KEY=$key|" \
      .env && rm -f .env.bak && chmod 600 .env && echo written
  else
    echo 'secret generation failed; .env unchanged' >&2
  fi
)
```

It prints `written` when it changed `.env`. The values come from `/dev/urandom` as hex.
Base64 would break the connection strings: the compose file puts both passwords into
`DATABASE_URL` and `CACHE_URL`, where `/`, `+` and `=` have a meaning.

## 3. Check them without printing them

```bash
grep -c -e '^DATABASE_PASSWORD=[0-9a-f]\{48\}$' -e '^CACHE_PASSWORD=[0-9a-f]\{48\}$' -e '^LUMASTRA_MASTER_KEY=[0-9a-f]\{64\}$' .env
```

This must print `3`.

## Windows without WSL

Run this in PowerShell in the install folder instead. It makes the same three changes:

```powershell
function Hex($n) { $b = New-Object byte[] $n; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
(Get-Content .env) `
  -replace '^DATABASE_PASSWORD=.*', "DATABASE_PASSWORD=$(Hex 24)" `
  -replace '^CACHE_PASSWORD=.*', "CACHE_PASSWORD=$(Hex 24)" `
  -replace '^# LUMASTRA_MASTER_KEY=.*', "LUMASTRA_MASTER_KEY=$(Hex 32)" |
  Set-Content .env
```

Check all three, which must print `3`:

```powershell
(Select-String -Path .env -Pattern '^DATABASE_PASSWORD=[0-9a-f]{48}$','^CACHE_PASSWORD=[0-9a-f]{48}$','^LUMASTRA_MASTER_KEY=[0-9a-f]{64}$').Count
```

Windows PowerShell 5.1 may change non-ASCII characters in the comments of `.env`. The
values are not affected.

## TMDB credential

`.env.example` has no TMDB line. The setup wizard asks for the key, or it can go into
`.env`.

On https://www.themoviedb.org/settings/api, TMDB shows an "API Key" and an "API Read
Access Token". Either one works in `TMDB_API_KEY`. Offer the person two options:

- They add the line `TMDB_API_KEY=<value>` to `.env` themselves in an editor. This keeps
  the value out of the chat.
- They give you the value, and you add the line. First run
  `grep -c '^TMDB_API_KEY=' .env`. If it prints `0`, append the line:
  `printf '\nTMDB_API_KEY=%s\n' '<value>' >> .env`. If it prints anything else, ask the
  person which value to keep.

They can also skip TMDB now. To add it later, add the line and run
`docker compose up -d` again.

## Master key backup

`LUMASTRA_MASTER_KEY` encrypts every secret Lumastra stores (tokens, webhook secrets,
plugin and integration credentials). The person must copy it from `.env` into a password
manager or another place outside the server. Don't print the key for them; they open
`.env` themselves. Rotation and recovery: https://lumastra.org/guides/master-key-rotation/

## Other variables

`.env.example` lists only deployment settings; everything else is set in the setup wizard
and under Admin -> Settings. Every setting in `.env` other than the three secrets and
`AUTH_NATIVE_LOGIN_ENABLED` is commented out by default. The reverse
proxy step adds `ORIGIN` and `TRUSTED_PROXY_IPS`. The full list is at
https://lumastra.org/reference/environment-variables/. A value in the `environment:`
block of `docker-compose.yml` overrides the same variable in `.env`.
