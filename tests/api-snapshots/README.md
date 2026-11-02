# Public API before/after snapshots

`endpoints.ts` names 60 public-spec GET operations covering normal and admin contracts.
Capture authenticates separately as `sweepuser` (Users; read/write PAT) and
`safetynet-admin` (Kreditoren; admin PAT), and revokes each minted PAT in `finally`.
The shared internal PAT mint/revoke calls are **test-harness login, a real third-party
client uses the OAuth device flow**. All resource requests must match a GET in
`docs/api/api-v1.yaml`; no application code is imported.

Run from the app directory against preprod:

```sh
lumastra-remote --pull tests/api-snapshots/data 'npm run api-snapshots:capture'
lumastra-remote --pull tests/api-snapshots/data/compare-report.json 'npm run api-snapshots:compare'
```

Capture discovers playable movie/series ids using paginated browse, then seasons, episodes,
cast, music, audiobook and channel ids. `_index.json` records these ids and explicit empty
content skips. Snapshots contain `{request:{method,path},status,contentType,body}`; compare
reuses each recorded path, including ids and the original guide window. Roles both capture
admin endpoints: a normal user's baseline 403 is meaningful. No streams start during capture.

The public spec currently has no system-health, client-diagnostics-list or api-conformance
GET operation. `_index.json` records these coverage gaps rather than making undocumented
internal requests. Publish those operations in the public spec before adding them here.
Collections use `/lists`; ratings use the selected movie's `/rating`; me uses `/me`.

Redaction happens before **every** JSON write, including reports. It replaces credential
fields, token prefixes/JWTs, credential URL query values, emails, non-test usernames,
IP addresses and filesystem paths. Public request paths and media UUIDs remain reusable.
Do not share a capture without inspecting it:

```sh
rg -n 'pat_|svc_|@|api_key|denis' tests/api-snapshots/data
```

`api_key=[credential]` matches are expected placeholders, never credentials. Review sample
user/admin files and filesystem-path fields too. Redaction deliberately keeps structure.

Comparison ignores scalar-value changes and array ordering/count differences. It checks:

- Status class unchanged; a captured error remains a baseline error, not proof of success.
- Every captured key path remains, using the union of array-member shapes at `[]` paths.
- Every previously nonempty array stays nonempty.
- Known media UUID references still resolve (music-session media ids use track detail).
- Up to five same-origin advertised artwork/m3u8 URLs per endpoint answer HEAD (GET fallback
  on 405/501) with 2xx/3xx. External URLs are not fetched and bearer tokens are never sent
  across origins. Live TV/audiobook manifests are excluded because they can allocate provider
  sessions; recipe 08 owns the single bounded Live TV stream.

Removed keys, status-class changes, emptied arrays, unresolvable ids and failing URLs are
BROKEN and cause exit 1. Added keys are CHANGED (informational); other endpoints are OK.
`data/compare-report.json` contains the redacted full details. A stable 4xx/5xx is explicitly
not a new regression; inspect capture statuses alongside the recipe results.

For the **Release readiness check** session, run exactly:

```sh
lumastra-remote --pull tests/api-snapshots/data/compare-report.json 'npm run api-snapshots:compare'
```

An intentional package rename must break the old snapshot first. Review that break, update
its recipe, then refresh just the affected keys and compare again:

```sh
lumastra-remote --pull tests/api-snapshots/data 'npm run api-snapshots:capture -- --only movie,images,episode'
lumastra-remote --pull tests/api-snapshots/data/compare-report.json 'npm run api-snapshots:compare'
```

Partial captures preserve recorded ids and unaffected snapshots. A full capture rediscovers
ids. Do not bless accidental changes by recapturing before reviewing the report.
See [VERIFICATION.md](VERIFICATION.md) for this implementation's actual execution evidence.

## Opaque (free-form) payloads

`OPAQUE_PATHS` in `semantic.ts` lists free-form payloads (a run's `result` envelope, run/task `input`,
task `settings`). They must exist and keep their JSON type, but their inner keys are not diffed, since
they vary with data rather than with the contract. Add a path only for a genuinely free-form payload.
