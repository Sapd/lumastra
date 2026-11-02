# API Documentation

Quick-reference for agents working on docs/api/ or the /api/v1 surface.

## Files

| File          | What                                           | When to read                                                  |
| ------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| `README.md`   | Architecture, auth model, response conventions | Before touching any API or defs/ file                         |
| `API.md`      | Client guide: OAuth flow, HLS, SSE             | Platform-specific integration; not an endpoint listing        |
| `api-v1.yaml` | Generated OpenAPI spec for `/api/v1/*`         | Checking the public contract; regenerate after changing defs/ |

> ⚠️ **`API.md` is a runtime artifact, not just a doc.** `src/routes/api-docs/+server.ts`
> and `src/routes/llms.txt/+server.ts` `readFileSync` it and serve it at
> `/api-docs?format=md` and `/llms.txt`, with a silent one-line fallback if it is missing.
> Do not delete it. Its reader-facing counterpart is https://lumastra.org/developers/api/ —
> keep the two in sync when the public API changes.

## Where handlers live

Every `/api/v1` endpoint is a **def file** in `src/lib/server/api/defs/`.
Route files under `src/routes/api/v1/` are **auto-generated** — do not edit them.

```
src/lib/server/api/
  define.ts     EndpointDef, AuthSpec, ApiContext, ApiScope types + defineEndpoint()
  mount.ts      mount(def, ctx) — wraps defs into SvelteKit RequestHandlers
  problem.ts    problem+json builder, paginate(), ApiProblem.* shortcuts
  principal.ts  Principal, buildPrincipal(), deriveIsAdmin(), expandScopes()
  defs/         one file (or index.ts) per URL pattern, each exports `def`
```

## Generating the spec and routes

```bash
# Regenerate OpenAPI spec from defs/
npm run openapi:generate

# Regenerate (or check) route files
npx tsx --tsconfig tsconfig.scripts.json scripts/gen-api-routes.ts
npx tsx --tsconfig tsconfig.scripts.json scripts/gen-api-routes.ts --check  # CI
```

## Adding an endpoint

1. Create `src/lib/server/api/defs/<domain>/<name>.ts` exporting `def`.
2. Declare `auth` with the narrowest correct `AuthSpec`.
3. A def that serves several methods at one path limits `request.query` and `request.body` to the methods that read them with `queryMethods` / `bodyMethods` (a POST that creates takes no list params; a DELETE takes no body).
4. Run `npm run openapi:generate` + the route generator.
5. Verify with `npm run build`.

`{kind:'public'}` is the **only** way to ship an un-gated route — it must be
an explicit, reviewable choice.

## Auth rules (critical)

- `enforce()` reads **only** `locals.principal` — never the URL prefix.
- Admin token rule: `isAdmin` = `ownerIsAdmin AND explicit admin scope`. A low-scope
  PAT owned by an admin is NOT admin.
- `{kind:'feature'}` → disabled feature returns `404`, not `403`.
- Per-method auth: every method key in `handlers` must appear in the auth map —
  missing methods fail-closed (403).

## Response rules

- Success = bare object or `{ items, page }` — no `{ success, data }` wrapper.
- Errors = `application/problem+json` with a `code` from the closed taxonomy.
- Dependency down = **always** `503 dependency_unavailable`, never `200 + []`.
- `hasMore` is mandatory on every paginated response.

## Key types (import from `$lib/server/api`)

```ts
import {
    defineEndpoint, // factory — annotates a def for the generator
    mount, // wraps a def into SvelteKit RequestHandlers
    enforce, // evaluate AuthSpec for an event
    ApiProblem, // problem+json shortcuts (notFound, forbidden, …)
    problem, // raw problem+json builder
    paginate, // build { items, page } collection envelope
    buildPrincipal, // construct a Principal from resolved identity
    deriveIsAdmin, // single admin-gate rule
    expandScopes, // coarse alias → fine-grained scope expansion
} from '$lib/server/api';
```
