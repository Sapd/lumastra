// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client ↔ Server contract-parity guard (static source analysis).
 *
 * WHY THIS TEST EXISTS — the gap in the existing guards
 * ---------------------------------------------------------------------------
 * Three guards already touch the API surface, but none of them compares a
 * CLIENT zod schema against the SERVER's documented contract:
 *
 *   - `src/lib/api/client.ts` (`apiFetch`) validates the response against the
 *     client schema at RUNTIME, but it fails OPEN: a mismatch just sets
 *     `validationError` and returns the raw payload. Nothing fails a build or
 *     a test run — the drift is silently tolerated in production.
 *   - `tests/integration/openapi-contract.integration.test.ts` invokes a
 *     handler and checks its JSON body against the SERVER's OWN documented
 *     schema (`_openapi.ts`). That only catches the handler drifting from its
 *     OWN doc — it never looks at what any client expects.
 *   - `tests/api-v1-parity.test.ts` / `api-v1-auth-coverage.test.ts` check
 *     route SHAPE (shim vs mount vs tombstone) and auth declarations — not
 *     response schemas at all, and they only look at "is this file a thin
 *     shim", never at a schema's field set.
 *
 * So a client that still expects `{ seasons }` / `{ tokens }` /
 * `{ excludedSeries }` while the server has moved to the redesigned
 * `{ items, page }` envelope sails through every existing test. This test
 * closes that gap.
 *
 * WHAT THIS TEST DOES (3 steps, static analysis only — no module execution,
 * no DB, no network; mirrors the source-text-parsing idiom already used by
 * api-v1-parity.test.ts / api-v1-auth-coverage.test.ts)
 * ---------------------------------------------------------------------------
 * 1. EXTRACT client call sites: scan `src/lib/api/*.ts` for the uniform
 *    `apiGet(<path>, <SchemaIdentifier>, ...)` idiom. Normalize the path
 *    (strip query string, collapse `${...}` template interpolations to a
 *    `{param}` placeholder, strip a leading `/api/v1` or `/api`).
 * 2. RESOLVE the SERVER-documented 2xx response schema for that same path+GET
 *    by walking `src/routes/api/v1/**` (falling back to `src/routes/api/**`
 *    for routes that never got a v1 mount) for a directory whose segments
 *    match positionally (`[anything]` dirs match a `{param}` placeholder),
 *    then parsing that route's colocated `_openapi.ts` for its
 *    `GET.responses[2xx].schema` identifier — the same RouteMetadata/
 *    ResponseDef shape the integration contract guard already imports as a
 *    TYPE (we do not import it as a value/module — see "no module execution"
 *    above — but the shape we hand-parse is exactly that one).
 * 3. ASSERT structural compatibility: resolve both schema identifiers to
 *    their top-level key set (by locating the `z.object({...})` /
 *    `z.union([...])` declaration in-file or one import hop into
 *    `$lib/schemas/*`, then reading the object's top-level property names —
 *    a union's key surface is the union of its branches' keys). The rule is
 *    intentionally coarse: the CLIENT's top-level required keys must be a
 *    SUBSET of the SERVER's top-level keys. A client expecting `episodes` /
 *    `tokens` while the server now emits `items,page` fails this subset
 *    check immediately. We do not compare nested fields or types — that is
 *    brittle and out of scope; the goal is catching top-level envelope /
 *    discriminator drift with a low false-positive rate.
 *
 * Endpoints that can't be resolved this way (non-GET, dynamic/unresolvable
 * path expressions, inline anonymous schemas, no server _openapi.ts match,
 * etc.) are not silently skipped — they're collected and printed as a visible
 * TODO list so coverage gaps stay honest. A handful of call sites are known
 * ALLOWLISTED PENDING cases (drift fixes in flight elsewhere at the time this
 * test was written); see `PENDING_DRIFT` below.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Small parsing primitives (same brace-matching idiom as api-v1-auth-coverage.test.ts)
// ---------------------------------------------------------------------------

function stripComments(src: string): string {
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    src = src.replace(/\/\/[^\n]*/g, '');
    return src;
}

/** Extract the balanced `{...}` body starting at the first `{` at/after `fromIdx`. */
function extractBalancedBraces(src: string, fromIdx: number): string | null {
    const start = src.indexOf('{', fromIdx);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null; // unbalanced
}

/** Extract the balanced `[...]` body starting at the first `[` at/after `fromIdx`. */
function extractBalancedBrackets(src: string, fromIdx: number): string | null {
    const start = src.indexOf('[', fromIdx);
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Split a balanced `{...}` object body into its TOP-LEVEL `key: value` pairs
 * (depth-aware — does not descend into nested braces/brackets/parens/strings).
 * Returns [key, valueText] pairs; value text is un-trimmed of trailing commas.
 */
function splitTopLevelEntries(objBody: string): Array<[string, string]> {
    // Strip the outer braces.
    const inner = objBody.slice(1, -1);
    const entries: Array<[string, string]> = [];
    let depth = 0;
    let inStr: string | null = null;
    let keyStart = 0;
    let colonIdx = -1;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (inStr) {
            if (ch === inStr && inner[i - 1] !== '\\') inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inStr = ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        else if (ch === '}' || ch === ']' || ch === ')') depth--;
        else if (depth === 0 && ch === ':' && colonIdx === -1) {
            colonIdx = i;
        } else if (depth === 0 && ch === ',') {
            if (colonIdx !== -1) {
                const key = inner
                    .slice(keyStart, colonIdx)
                    .trim()
                    .replace(/^['"]|['"]$/g, '');
                const value = inner.slice(colonIdx + 1, i).trim();
                if (key) entries.push([key, value]);
            }
            keyStart = i + 1;
            colonIdx = -1;
        }
    }
    // Final entry (no trailing comma).
    if (colonIdx !== -1) {
        const key = inner
            .slice(keyStart, colonIdx)
            .trim()
            .replace(/^['"]|['"]$/g, '');
        const value = inner.slice(colonIdx + 1).trim();
        if (key) entries.push([key, value]);
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Zod schema key-surface resolution (static text — no zod objects imported)
// ---------------------------------------------------------------------------

interface KeySurface {
    /** ALL top-level property names present on the schema (required + optional). */
    keys: Set<string>;
    /**
     * The subset of `keys` that are NOT `.optional()`/`.nullish()` — i.e. keys
     * a real response is guaranteed to carry. Only THESE are checked against
     * the other side's `keys` (see the compatibility rule in the driver) —
     * an optional client field with no server counterpart is not drift (the
     * client already tolerates its absence), matching the spec's "avoid
     * brittle field-by-field equality" guidance.
     */
    requiredKeys: Set<string>;
    /** true when resolution had to give up (unknown shape) — excluded from asserts. */
    unresolved?: string;
}

/** True when a top-level property's value expression ends in `.optional()` or `.nullish()`. */
function isOptionalValueExpr(valueExpr: string): boolean {
    return /\.\s*(optional|nullish)\s*\(\s*\)/.test(valueExpr);
}

const SRC_DIR = new URL('../src/', import.meta.url).pathname;

/** Cache of file source by absolute path, to avoid re-reading during a run. */
const fileCache = new Map<string, string | null>();
function readFileCached(absPath: string): string | null {
    if (fileCache.has(absPath)) return fileCache.get(absPath)!;
    let content: string | null;
    try {
        content = readFileSync(absPath, 'utf8');
    } catch {
        content = null;
    }
    fileCache.set(absPath, content);
    return content;
}

/**
 * Resolve a `$lib/schemas/...` (or relative) import specifier to an absolute
 * file path on disk, trying the literal path, a `.ts` suffix, and an
 * `.js` → `.ts` swap (source files are authored as `.ts`, imported as `.js`
 * per NodeNext resolution).
 */
function resolveModuleSpecifier(spec: string, fromFile: string): string | null {
    let rel: string;
    if (spec.startsWith('$lib/')) {
        rel = SRC_DIR + 'lib/' + spec.slice('$lib/'.length);
    } else if (spec.startsWith('.')) {
        const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
        rel = dir + '/' + spec;
    } else {
        return null; // bare package specifier — not a local schema module
    }
    rel = rel.replace(/\.js$/, '');
    for (const candidate of [rel + '.ts', rel]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Find where `name` is imported OR re-exported from in `src` — covers both
 * `import { Name } from '...'` (named import) and `export { Name } from '...'`
 * (re-export barrel, e.g. `api-content-responses.ts` re-exporting
 * `MediaDetailSchema` from `./media-detail`). Returns the resolved absolute
 * file path, or null if `name` is neither imported nor re-exported here (i.e.
 * it's expected to be declared locally in `src`).
 */
function findImportSource(src: string, name: string, fromFile: string): string | null {
    const importRe = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src))) {
        const names = m[1].split(',').map((s) =>
            s
                .trim()
                .split(/\s+as\s+/)
                .pop()!
                .trim(),
        );
        if (names.includes(name)) {
            return resolveModuleSpecifier(m[2], fromFile);
        }
    }
    return null;
}

/**
 * Locate `const <name> = <expr>` (or `export const <name> = <expr>`) at the
 * top level of `src` and return the expression text up to (but not
 * including) the terminating top-level semicolon/newline-at-depth-0.
 */
function findConstDeclaration(src: string, name: string): string | null {
    const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    const exprStart = m.index + m[0].length;
    // Walk forward tracking paren/brace/bracket depth until we hit a `;` at
    // depth 0, or two consecutive newlines at depth 0 (best-effort).
    let depth = 0;
    let inStr: string | null = null;
    for (let i = exprStart; i < src.length; i++) {
        const ch = src[i];
        if (inStr) {
            if (ch === inStr && src[i - 1] !== '\\') inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            inStr = ch;
            continue;
        }
        if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') depth--;
        else if (depth === 0 && ch === ';') {
            return src.slice(exprStart, i);
        }
    }
    return null;
}

/**
 * Resolve the top-level key surface of a schema expression (`z.object({...})`,
 * `z.union([...])`, or a chain like `z.object({...}).meta({...})` /
 * `.catchall(...)`. Only the FIRST `z.object({...})` at the start of the
 * expression, or every object branch of a `z.union([...])`/
 * `z.discriminatedUnion(k, [...])`, contributes keys. Anything else
 * (`z.array(...)`, `z.string()`, a bare identifier reference, etc.) is
 * reported unresolved rather than guessed at.
 */
function resolveExprKeySurface(expr: string, depth = 0): KeySurface {
    const trimmed = expr.trim();

    if (depth > 3)
        return {
            keys: new Set(),
            requiredKeys: new Set(),
            unresolved: 'max recursion depth exceeded',
        };

    if (/^z\s*\.\s*object\s*\(/.test(trimmed)) {
        const objBody = extractBalancedBraces(trimmed, trimmed.indexOf('('));
        if (!objBody)
            return {
                keys: new Set(),
                requiredKeys: new Set(),
                unresolved: 'unbalanced z.object({...})',
            };
        const entries = splitTopLevelEntries(objBody);
        const keys = new Set(entries.map(([k]) => k));
        const requiredKeys = new Set(
            entries.filter(([, v]) => !isOptionalValueExpr(v)).map(([k]) => k),
        );
        return { keys, requiredKeys };
    }

    if (/^z\s*\.\s*(union|discriminatedUnion)\s*\(/.test(trimmed)) {
        // For discriminatedUnion the first arg is the discriminator key name —
        // skip to the array of branch schemas either way.
        const arrBody = extractBalancedBrackets(trimmed, 0);
        if (!arrBody)
            return {
                keys: new Set(),
                requiredKeys: new Set(),
                unresolved: 'unbalanced union branch array',
            };
        const inner = arrBody.slice(1, -1);
        // Split top-level branches (comma at depth 0).
        const branches: string[] = [];
        let bdepth = 0;
        let start = 0;
        for (let i = 0; i < inner.length; i++) {
            const ch = inner[i];
            if (ch === '{' || ch === '[' || ch === '(') bdepth++;
            else if (ch === '}' || ch === ']' || ch === ')') bdepth--;
            else if (ch === ',' && bdepth === 0) {
                branches.push(inner.slice(start, i));
                start = i + 1;
            }
        }
        branches.push(inner.slice(start));
        // Union key-surface (`keys`) = union of every branch's keys (pragmatic:
        // a client expecting a key present on ANY branch is tolerated). Union
        // requiredKeys = INTERSECTION of every branch's requiredKeys (only a
        // key every branch guarantees is guaranteed by the union as a whole).
        const keys = new Set<string>();
        let requiredKeys: Set<string> | null = null;
        for (const b of branches) {
            const sub = resolveExprKeySurface(b, depth + 1);
            if (sub.unresolved)
                return {
                    keys: new Set(),
                    requiredKeys: new Set(),
                    unresolved: `union branch: ${sub.unresolved}`,
                };
            for (const k of sub.keys) keys.add(k);
            requiredKeys =
                requiredKeys === null
                    ? new Set(sub.requiredKeys)
                    : new Set([...requiredKeys!].filter((k: string) => sub.requiredKeys.has(k)));
        }
        return { keys, requiredKeys: requiredKeys ?? new Set() };
    }

    return {
        keys: new Set(),
        requiredKeys: new Set(),
        unresolved: `unrecognized schema expression: ${trimmed.slice(0, 60)}`,
    };
}

/**
 * Resolve `identifier`'s key surface starting the search in `srcFile`,
 * following import/re-export hops (named imports AND `export {X} from`
 * barrels — e.g. `api-content-responses.ts` re-exporting `MediaDetailSchema`
 * from `./media-detail`) up to a small bounded depth, then resolving the
 * `const <identifier> = <expr>` declaration. When the declaration's RHS is
 * itself just another bare identifier (an alias, e.g.
 * `const FooResponseSchema = FooContractSchema;`) or a chain on one
 * (`BarSchema.meta({...})`), we recurse into THAT identifier in the same
 * file rather than treating it as an unresolved shape.
 */
function resolveSchemaKeySurface(identifier: string, srcFile: string, hopsLeft = 4): KeySurface {
    if (hopsLeft <= 0) {
        return {
            keys: new Set(),
            requiredKeys: new Set(),
            unresolved: `import hop limit exceeded resolving ${identifier}`,
        };
    }

    const localSrc = readFileCached(srcFile);
    if (!localSrc)
        return {
            keys: new Set(),
            requiredKeys: new Set(),
            unresolved: `could not read ${srcFile}`,
        };
    const stripped = stripComments(localSrc);

    const importedFrom = findImportSource(stripped, identifier, srcFile);
    if (importedFrom) {
        // Followed an import/re-export hop — resolve `identifier` again, but
        // now searching in the target file (it may itself just re-export
        // further, hence the bounded recursion rather than a single hop).
        return resolveSchemaKeySurface(identifier, importedFrom, hopsLeft - 1);
    }

    const declExpr = findConstDeclaration(stripped, identifier);
    if (!declExpr) {
        return {
            keys: new Set(),
            requiredKeys: new Set(),
            unresolved: `no 'const ${identifier} = ...' declaration found in ${srcFile}`,
        };
    }

    // Alias / chain-on-identifier: `= OtherSchema` or `= OtherSchema.meta({...})`.
    // Recurse into OtherSchema within the SAME file (aliases don't cross files
    // here — if they did, the import-hop branch above would have caught it).
    const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\.[\s\S]*)?$/.exec(declExpr.trim());
    if (aliasMatch && !/^z\b/.test(aliasMatch[1])) {
        return resolveSchemaKeySurface(aliasMatch[1], srcFile, hopsLeft - 1);
    }

    return resolveExprKeySurface(declExpr);
}

/**
 * Resolve a schema reference that may be:
 *   - a bare identifier (`FooResponseSchema`) — look up its `const`
 *     declaration, following import/re-export/alias hops;
 *   - an identifier with a trailing chain (`FooSchema.meta({...})`, as seen
 *     inline in `_openapi.ts` `schema:` values) — resolve the base
 *     identifier the same way, ignoring the chain;
 *   - a fully inline expression (`z.object({...})` / `z.union([...])`)
 *     written directly at the `schema:` call site.
 */
function resolveSchemaRef(exprOrIdentifier: string, srcFile: string): KeySurface {
    const trimmed = exprOrIdentifier.trim();
    if (isBareIdentifier(trimmed)) {
        return resolveSchemaKeySurface(trimmed, srcFile);
    }
    const chainMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*\.[\s\S]*$/.exec(trimmed);
    if (chainMatch && !/^z$/.test(chainMatch[1])) {
        return resolveSchemaKeySurface(chainMatch[1], srcFile);
    }
    return resolveExprKeySurface(trimmed);
}

// ---------------------------------------------------------------------------
// Step 1 — extract client `apiGet(path, Schema)` call sites
// ---------------------------------------------------------------------------

interface ClientCallSite {
    file: string;
    /** Normalized path: query stripped, `${...}` → `{param}`, no /api|/api/v1 prefix. */
    normalizedPath: string;
    rawPath: string;
    schemaIdentifier: string;
}

/** Matches `apiGet(<string-or-template-literal>, <identifier>` across newlines. */
const API_GET_RE =
    /\bapiGet\(\s*(['"`])((?:(?!\1)[\s\S])*)\1\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;

function normalizeClientPath(raw: string): string {
    let p = raw.split('?')[0];
    p = p.replace(/\$\{[^}]*\}/g, '{param}');
    p = p.replace(/^\/api\/v1(?=\/|$)/, '');
    p = p.replace(/^\/api(?=\/|$)/, '');
    if (!p.startsWith('/')) p = '/' + p;
    return p;
}

async function extractClientCallSites(): Promise<ClientCallSite[]> {
    const pattern = new URL('../src/lib/api/*.ts', import.meta.url).pathname;
    const files: string[] = [];
    for await (const f of glob(pattern)) {
        if (f.endsWith('.test.ts')) continue;
        files.push(f);
    }

    const sites: ClientCallSite[] = [];
    for (const file of files.sort()) {
        const raw = readFileSync(file, 'utf8');
        const stripped = stripComments(raw);
        API_GET_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = API_GET_RE.exec(stripped))) {
            const rawPath = m[2];
            if (!rawPath.startsWith('/api')) continue; // not a real API path (e.g. JSDoc example)
            sites.push({
                file,
                rawPath,
                normalizedPath: normalizeClientPath(rawPath),
                schemaIdentifier: m[3],
            });
        }
    }
    return sites;
}

// ---------------------------------------------------------------------------
// Step 2 — resolve the server-documented GET 2xx schema for a path
// ---------------------------------------------------------------------------

const V1_ROUTES_ROOT = new URL('../src/routes/api/v1', import.meta.url).pathname;
const LEGACY_ROUTES_ROOT = new URL('../src/routes/api', import.meta.url).pathname;

/**
 * Walk a routes root directory following `normalizedPath` segments, matching
 * a literal directory name first and falling back to a `[...]`-bracketed
 * dynamic segment (SvelteKit's own route-matching semantics) when the
 * normalized path segment is a `{param}` placeholder. Returns the matched
 * route directory's absolute path, or null.
 */
function resolveRouteDir(root: string, normalizedPath: string): string | null {
    const segments = normalizedPath.split('/').filter(Boolean);
    let dir = root;
    for (const seg of segments) {
        if (!existsSync(dir)) return null;
        const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
        let next: string | null = null;

        if (seg !== '{param}') {
            const literalMatch = entries.find((e) => e.name === seg);
            if (literalMatch) next = literalMatch.name;
        }
        if (!next) {
            // Fall back to a single dynamic segment dir: [id], [name], [...path], etc.
            const dynamicMatch = entries.find((e) => /^\[.+\]$/.test(e.name));
            if (dynamicMatch) next = dynamicMatch.name;
        }
        if (!next) return null;
        dir = dir + '/' + next;
    }
    return existsSync(dir) ? dir : null;
}

/**
 * Pull the documented GET 2xx response schema EXPRESSION TEXT out of a
 * route's `_openapi.ts` source. The `schema:` value is usually a bare
 * identifier (`schema: FooResponseSchema`) but is sometimes an inline
 * expression (`schema: z.object({...}).meta({...})`) — we return the raw
 * expression text either way and let `resolveExprKeySurface`
 * (identifier form) or a direct parse (inline form) figure out which.
 * Uses `splitTopLevelEntries` (same depth-aware entry splitter used for
 * client call-site parsing) so a nested `{`/`}` inside the schema expression
 * doesn't truncate the match.
 */
function extractGet2xxSchemaExpr(openapiSrc: string): string | null {
    const stripped = stripComments(openapiSrc);
    const getMatch = /\bGET\s*:\s*\{/.exec(stripped);
    if (!getMatch) return null;
    const getBlock = extractBalancedBraces(stripped, getMatch.index);
    if (!getBlock) return null;

    const responsesMatch = /\bresponses\s*:\s*\{/.exec(getBlock);
    if (!responsesMatch) return null;
    const responsesBlock = extractBalancedBraces(getBlock, responsesMatch.index);
    if (!responsesBlock) return null;

    for (const status of [200, 201, 202]) {
        const statusRe = new RegExp(`\\b${status}\\s*:\\s*\\{`);
        const statusMatch = statusRe.exec(responsesBlock);
        if (!statusMatch) continue;
        const statusBlock = extractBalancedBraces(responsesBlock, statusMatch.index);
        if (!statusBlock) continue;
        const entries = splitTopLevelEntries(statusBlock);
        const schemaEntry = entries.find(([k]) => k === 'schema');
        if (schemaEntry) return schemaEntry[1];
    }
    return null;
}

/** True when `expr` is a single bare identifier (`FooSchema`), not an inline expression. */
function isBareIdentifier(expr: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr.trim());
}

interface ServerResolution {
    routeDir: string;
    openapiFile: string;
    /** Either a bare identifier or a full inline schema expression (see `isBareIdentifier`). */
    schemaExpr: string;
}

/**
 * Resolve the server-side GET 2xx schema for a normalized path.
 *
 * Every client call site in `src/lib/api/*.ts` targets a LEGACY `/api/...`
 * path (none call `/api/v1/...` directly) — the legacy route is what
 * actually serves the request. Routes at the same URL under `/api/v1/*` are
 * NOT guaranteed to be the same endpoint: several legacy paths are reused by
 * an unrelated v1 endpoint (e.g. `/api/media/{id}/metadata` is a lock-status
 * check, while `/api/v1/media/{id}/metadata` is an unrelated custom-metadata
 * JSONB endpoint — same URL, different `def`, no shim relationship). So the
 * legacy route directory is ALWAYS resolved first; `/api/v1` is consulted
 * only when the legacy route doesn't exist at all (fully migrated/removed
 * from the legacy surface, canonical implementation now lives on v1).
 */
function resolveServerSchema(normalizedPath: string): ServerResolution | { unresolved: string } {
    for (const root of [LEGACY_ROUTES_ROOT, V1_ROUTES_ROOT]) {
        const routeDir = resolveRouteDir(root, normalizedPath);
        if (!routeDir) continue;
        const openapiFile = routeDir + '/_openapi.ts';
        if (!existsSync(openapiFile)) {
            // The route exists but documents nothing — do NOT fall through to
            // v1 (that would silently compare against an unrelated endpoint
            // that happens to share the URL). Report as unresolved instead.
            return { unresolved: `route found at ${routeDir} but it has no _openapi.ts` };
        }
        const expr = extractGet2xxSchemaExpr(readFileSync(openapiFile, 'utf8'));
        if (!expr) {
            return { unresolved: `${openapiFile} has no documented GET 2xx schema` };
        }
        return { routeDir, openapiFile, schemaExpr: expr };
    }
    return { unresolved: `no route directory found under legacy or v1 routes` };
}

// ---------------------------------------------------------------------------
// Known pending drift — endpoints intentionally NOT hard-asserted here yet.
//
// Each entry was individually verified by reading the actual handler/def
// (not just the client and the doc) to classify WHERE the drift really is:
//
//   [STALE DOC]   The route's `def` handler already emits the shape the
//                 client expects (confirmed via its `json(...)`/`paginate(...)`
//                 call site) — only the colocated `_openapi.ts` documents an
//                 old shape (frequently a legacy `{success,data,timestamp}`
//                 envelope). Fix: update that `_openapi.ts` to document the
//                 handler's real shape. No client or handler change needed.
//   [REAL DRIFT]  The handler itself has NOT been migrated — it emits a
//                 shape that matches neither the client nor a corrected doc.
//                 Fix: migrate the handler (or the client, if the handler's
//                 shape is intentional) — a real cross-team fix, not a docs typo.
//
// Remove an entry once the underlying fix lands (the assertion will then run
// for real and must pass).
//
// Key format: `${normalizedPath}::${clientSchemaIdentifier}` (matches the
// `dedupeKey` computed in the driver below).
// ---------------------------------------------------------------------------

const PENDING_DRIFT = new Set<string>([
    // [STALE DOC] GET /api/music/radio — handler (defs/music/radio/stations.ts)
    // emits paginate()'s {items,page}, matching the client
    // ($lib/schemas/api-music-responses.ts). _openapi.ts still documents an
    // old local {success,data,timestamp} RadioStationsResponseSchema.
    '/music/radio::RadioStationsResponseSchema',

    // [STALE DOC] GET /api/music/tracks/{id}/lyrics — the route's own doc
    // comment and handler (defs/music/tracks/[id]/lyrics.ts) emit a bare
    // { lyrics, syncedLines? }, matching the client's LyricsApiResponseSchema.
    // _openapi.ts documents an old local {success,data,timestamp} wrapper.
    '/music/tracks/{param}/lyrics::LyricsApiResponseSchema',

    // [STALE DOC] GET /api/movie/search — defs/media/movie-search.ts emits
    // `json(MovieSearchContractSchema.parse(data))`, i.e. the bare
    // {id,type,ids,...,images,isAvailable,canRequest,playbackAvailable}
    // shape the client (MovieSearchResponseSchema, aliased to
    // MovieSearchContractSchema) expects. _openapi.ts still documents the
    // old MediaDetailsSchema.
    '/movie/search::MovieSearchResponseSchema',

    // [STALE DOC] GET /api/series/search — defs/catalog/series/search.ts
    // emits a bare {id,type,ids,title,year?,overview?,images?}, matching the
    // client's SeriesSearchResponseSchema. _openapi.ts still documents the
    // old TvDetailSchema.
    '/series/search::SeriesSearchResponseSchema',

    // [STALE DOC] GET /api/for-you/music-because — defs/for-you/music-because.ts
    // emits `json({ section })`/`json({ section: null })` throughout,
    // matching the client's MusicSectionResponseSchema. _openapi.ts still
    // documents the paginated SectionResponseSchema ({items,page}) used by
    // other for-you endpoints — wrong schema reference for this route.
    '/for-you/music-because::MusicSectionResponseSchema',

    // [STALE DOC] GET /api/music — defs/music/home.ts emits `json({ sections })`,
    // matching the client's MusicHomeSectionsResponseSchema. _openapi.ts
    // documents an inline old {success,data,timestamp} shape.
    '/music::MusicHomeSectionsResponseSchema',

    // NOTE: '/music/genres::MusicGenresResponseSchema' was cleared (their stale
    // legacy _openapi.ts docs now reference the real client schema) — see
    // M2 in the contract-cleanup backlog.

    // [STALE DOC] GET /api/movie-details/{id} — defs/catalog/movie-details.ts
    // emits `json({...}) satisfies MovieDetailsResponse` — the bare
    // {id,type,ids,...,images,isAvailable,canRequest,playbackAvailable,user}
    // shape the client (MovieDetailsResponseSchema) expects. _openapi.ts
    // still documents the old MovieDetailResponseSchema.
    '/movie-details/{param}::MovieDetailsResponseSchema',

    // [STALE DOC] GET /api/music/radio/{id}/now-playing —
    // defs/music/radio/[id]/now-playing.ts emits `json(result)` — its own
    // comment says "Bare object (single resource) — no envelope wrapper" —
    // matching the client's RadioNowPlayingResponseSchema. _openapi.ts
    // documents a local {success,data,timestamp} ResponseSchema instead.
    '/music/radio/{param}/now-playing::RadioNowPlayingResponseSchema',
]);

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe('client ↔ server contract parity (top-level key/discriminator drift)', () => {
    it('every resolvable apiGet() client schema is a subset of its server-documented schema', async () => {
        const callSites = await extractClientCallSites();
        expect(callSites.length, 'should find at least 150 apiGet() call sites').toBeGreaterThan(
            150,
        );

        const violations: string[] = [];
        const pending: string[] = [];
        const todo: string[] = [];
        let assertedCount = 0;

        // De-dupe by (normalizedPath, schemaIdentifier) — many call sites share
        // the same path+schema across differently-named wrapper functions.
        const seen = new Set<string>();

        for (const site of callSites) {
            const dedupeKey = `${site.normalizedPath}::${site.schemaIdentifier}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const server = resolveServerSchema(site.normalizedPath);
            if ('unresolved' in server) {
                todo.push(
                    `${site.rawPath} (${site.schemaIdentifier}, ${site.file}) — SERVER: ${server.unresolved}`,
                );
                continue;
            }

            const clientSurface = resolveSchemaKeySurface(site.schemaIdentifier, site.file);
            if (clientSurface.unresolved) {
                todo.push(
                    `${site.rawPath} (${site.schemaIdentifier}, ${site.file}) — CLIENT: ${clientSurface.unresolved}`,
                );
                continue;
            }

            const serverSurface = resolveSchemaRef(server.schemaExpr, server.openapiFile);
            if (serverSurface.unresolved) {
                todo.push(
                    `${site.rawPath} (${site.schemaIdentifier} vs ${server.schemaExpr}, ${server.openapiFile}) — SERVER SCHEMA: ${serverSurface.unresolved}`,
                );
                continue;
            }

            // Compatibility rule: the client's REQUIRED top-level keys must be
            // a SUBSET of the server's top-level keys (required + optional).
            // We only check the client's required keys — an `.optional()`
            // client field with no server counterpart isn't drift (the client
            // already tolerates its absence at runtime); the client may
            // otherwise be strict-or-narrower than the server, but it must
            // never REQUIRE a key the server doesn't emit at all.
            //
            // KNOWN TRADEOFF (documented, not a bug): this is a required-key
            // SUBSET check only — it does not verify VALUE TYPES, nested
            // shapes, or that the server doesn't emit EXTRA top-level keys the
            // client silently ignores. A field that changes type (e.g.
            // string → object) while keeping the same key name sails through.
            // Tightening this to a full structural/type comparison is
            // intentionally out of scope here (would be far more brittle
            // against legitimate server-side additive changes); if a
            // high-risk endpoint needs a stronger guarantee, opt it in with a
            // dedicated, narrowly-scoped test rather than tightening this
            // shared coarse guard for every endpoint.
            const missingOnServer = [...clientSurface.requiredKeys].filter(
                (k) => !serverSurface.keys.has(k),
            );

            if (missingOnServer.length > 0) {
                const label = `${site.rawPath} — client '${site.schemaIdentifier}' expects [${missingOnServer.join(', ')}] not present on server '${server.schemaExpr}' (server keys: [${[...serverSurface.keys].join(', ')}])`;
                if (PENDING_DRIFT.has(dedupeKey)) {
                    pending.push(label);
                } else {
                    violations.push(label);
                }
                continue;
            }

            assertedCount++;
        }

        // Visibility: print what's covered vs what's a gap, so coverage never
        // silently shrinks. This runs every pass, not just on failure.
        console.info(
            `[client-contract-parity] asserted ${assertedCount} pairing(s); ` +
                `${pending.length} known-pending drift; ${todo.length} unresolved (see TODO list below).`,
        );
        if (todo.length > 0) {
            console.info(
                `[client-contract-parity] TODO — unresolved endpoints:\n  ${todo.join('\n  ')}`,
            );
        }
        if (pending.length > 0) {
            console.info(
                `[client-contract-parity] known-pending drift:\n  ${pending.join('\n  ')}`,
            );
        }

        expect(
            assertedCount,
            'should structurally assert at least 35 client/server schema pairings',
        ).toBeGreaterThanOrEqual(35);

        expect(violations, violations.join('\n')).toHaveLength(0);
    });
});
