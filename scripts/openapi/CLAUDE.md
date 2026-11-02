# openapi/

OpenAPI specification generation — produces YAML specs from colocated `_openapi.ts` route metadata.

## Architecture

The versioned public + native-client surface (`/api/v1/*`) uses **colocated `_openapi.ts` sibling files** next to each `+server.ts` handler. The generator walks `src/routes/api/v1/`, follows re-exports, and imports `_openapi.ts` for metadata. Internal admin/misc API routes still use hand-written definitions in `routes/`.

**Where the generator looks for `_openapi.ts`, in order:** the ROUTE's own directory first, then the directory of the _resolved_ re-export target (which may be under `src/routes/api/...` or `src/lib/server/...`). The route wins because several routes may re-export ONE shared handler module — the three `/api/v1/audiobook/{mediaId}/…` byte routes all re-export `services/audiobook-stream-routes.ts`, and a single `_openapi.ts` beside that module could only describe one of them.

### Tags, operationIds and the sidebar (public spec)

`public-taxonomy.ts` decides, for every operation in `api-v1.yaml`, its one tag, its operationId,
the tag order and the `x-tagGroups` sections Scalar shows. A def's own `tags` / `operationId` only
apply to the internal spec. Generation fails when a public operation is missing from the registry,
an entry is stale, or an operationId is not verbNoun / is duplicated. `public-taxonomy.test.ts`
checks the committed spec. `LOCALIZED_OPERATIONS` there lists the operations that get the shared
`Accept-Language` header parameter.

The operationIds are also pinned in `public-operation-ids.lock.json` (`METHOD path` → operationId,
sorted by path then method). `public-operation-ids.lock.test.ts` compares it with `PUBLIC_TAXONOMY`
and fails on a removed or moved operation, a changed operationId, or a public operation with no
lock line. Adding a public operation means adding its lock line in
the same commit. Never change a locked id to make the test pass: follow docs/api/API.md "Stability
and deprecation" (new id alongside, deprecate the old one, remove it only in a release whose
changelog lists it).

### Stability tiers

Every operation carries an `x-stability` extension (`stable | beta | experimental | protocol |
deprecated`); the promise of each is in `docs/api/API.md` ("Stability and deprecation"). Public
operations MUST set `route.<METHOD>.stability` explicitly — generation fails otherwise. The
path-prefix default (`defaultStability()` in `generate-public.ts`) now only fills internal-spec
operations. `deprecated` needs a `deprecation: { since, sunset?, replacement }` block: the generator
emits `deprecated: true` + `x-deprecation`, and `mount()` adds `Deprecation` / `Sunset` / `Link`
response headers (`src/lib/server/api/deprecation.ts`).

## Files

| File                                | What                                                                   | When to read                                                |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `generate.ts`                       | Main entry point — orchestrates public + internal spec generation      | Running `npm run openapi:generate` or debugging output      |
| `generate-public.ts`                | Filesystem-walking collector for public routes (imports `_openapi.ts`) | Debugging route detection, re-export resolution             |
| `public-taxonomy.ts`                | Public tags, groups, operationIds (the reference's table of contents)  | Adding or moving a public /api/v1 operation                 |
| `public-operation-ids.lock.json`    | Every public `METHOD path` → operationId, pinned (see above)           | Adding a public operation (add its line in the same commit) |
| `public-operation-ids.lock.test.ts` | Fails on a removed, moved, renamed or unlocked public operation        | Test failure after a rename, move or new route              |
| `components.ts`                     | Shared OpenAPI component schemas (reusable types)                      | Adding reusable schema components                           |
| `helpers.ts`                        | Response builders, security constants, error bundles                   | Implementing new route spec helpers                         |
| `verify-spec.ts`                    | Validates generated spec fields against handler source                 | Debugging spec validation errors                            |

## Subdirectories

| Directory | What                                                                         | When to read                               |
| --------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `routes/` | Hand-written route specs for internal API only (admin.ts, misc.ts, oauth.ts) | Modifying internal/admin API documentation |

## Adding a new /api/v1 route

1. Create `+server.ts` handler as usual
2. Create `_openapi.ts` in the same directory (or the source handler directory for re-exports)
3. Add `METHOD /path` with a verbNoun operationId under the right tag in `public-taxonomy.ts`, set `stability`, and add its line to `public-operation-ids.lock.json`
4. Run `npm run openapi:check` to verify coverage
5. If the handler uses schemas, import them from `./_openapi` instead of `$lib/schemas/`
