// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Meta-test over every def-mounted route under src/routes/api/v1/series/.
 *
 * Publishing a music endpoint on v1 has three easy-to-miss requirements that
 * no type or lint rule enforces:
 *   1. `docs` (or, for a def mounted at more than one path, `docsByPath`
 *      returning metadata for THIS route's own path) must exist, or
 *      `npm run openapi:check` fails CI.
 *   2. `stability` must be set explicitly per method — /api/v1/music is in
 *      STABLE_PREFIXES (scripts/openapi/generate-public.ts:390), so an
 *      omitted tier publishes the route as `stable` rather than `beta`.
 *   3. `docs.visibility` must not be 'internal'. It is a ROUTE-level sibling
 *      of the per-method keys (define.ts:309), not a property inside each
 *      method's metadata — see src/lib/server/api/defs/tasks/observability.ts:16
 *      for the real shape. Getting that wrong diverts the path out of
 *      api-v1.yaml entirely (scripts/openapi/generate.ts:80).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../..');
const seriesV1Dir = join(repoRoot, 'src/routes/api/v1/series');

interface RouteInfo {
    file: string;
    /** Path of the file relative to the repo root, for readable test names/messages. */
    name: string;
    /**
     * Raw def-import specifier as it appears in source (e.g.
     * `$lib/server/api/defs/music/albums.js` or a relative path) — empty
     * when no `/defs/` import was found (only a `mount(` call matched).
     */
    defImport: string;
}

/**
 * Route files that mount a def (as opposed to bespoke handler routes).
 *
 * Discovery does NOT require the $lib import form: it collects any
 * `+server.ts` whose source imports from a path containing `/defs/`
 * (relative or `$lib`) OR calls `mount(`. That is deliberate — a route whose
 * def import is relative must still be discovered so the relative-import
 * check below actually runs on it, otherwise the guard can never fire for
 * the one case it exists to catch. `radio/stations/[id]/stream/+server.ts`
 * (a bare `export *` re-export) and `tracks/[id]/stream/+server.ts` (a
 * bespoke transcode handler) match neither condition and stay out of scope.
 *
 * Uses the async `glob` from node:fs/promises — the same API
 * scripts/gen-api-routes.ts uses, so it is known to work on this Node version.
 */
async function defMountedRoutes(): Promise<RouteInfo[]> {
    const out: RouteInfo[] = [];
    for await (const file of glob(join(seriesV1Dir, '**/+server.ts'))) {
        const src = readFileSync(file, 'utf8');
        const defImportMatch = /from\s+'([^']*\/defs\/[^']+)'/.exec(src);
        const callsMount = /\bmount\(/.test(src);
        if (!defImportMatch && !callsMount) continue;
        out.push({ file, name: relative(repoRoot, file), defImport: defImportMatch?.[1] ?? '' });
    }
    return out;
}

/**
 * Resolves a def-import specifier to something `import()` can load, whether
 * it's the `$lib/...` alias form or a relative path. Needed so the docs
 * check can still run (and fail loudly via the OTHER test) on a route whose
 * def is imported relatively, instead of throwing and aborting the run.
 */
function resolveDefSpecifier(file: string, specifier: string): string {
    if (!specifier.startsWith('.')) return specifier;
    return pathToFileURL(join(dirname(file), specifier)).href;
}

/**
 * Derives the OpenAPI path (`{param}` form) a route's `+server.ts` mounts at,
 * mirroring `filePathToOpenApiPath` in scripts/openapi/generate-public.ts —
 * needed here so a def using `docsByPath` (instead of a flat `docs`) can be
 * queried with the same path the real generator would ask for.
 */
function routeFileToOpenApiPath(file: string): string {
    const rel = relative(join(repoRoot, 'src/routes'), file);
    const dir = dirname(rel);
    const segments = dir.split(sep).map((seg) => {
        if (seg.startsWith('[...') && seg.endsWith(']')) return `{${seg.slice(4, -1)}}`;
        if (seg.startsWith('[') && seg.endsWith(']')) return `{${seg.slice(1, -1)}}`;
        return seg;
    });
    return '/' + segments.join('/');
}

// Module scope — NOT inside the `describe` callback below. Top-level await
// works here on this repo's Vitest 4.1.2; it does not work directly inside a
// `describe` callback, which is why discovery happens up here and `describe`
// just consumes the already-resolved `routes` array with `it.each`. This
// keeps one named, independently-failing test per route (per-route failure
// isolation), rather than one `it` with nested loops that aborts at the
// first failing route.
const routes = await defMountedRoutes();

describe('v1 series mounts', () => {
    it('finds def-mounted routes to check', () => {
        expect(routes.length).toBeGreaterThan(0);
    });

    it.each(routes)(
        'imports its def via the $$lib specifier, never a relative path: $name',
        ({ name, defImport }) => {
            // gen-api-routes.ts:269 only recognises the $lib form as a hand mount.
            // A relative import makes the generator emit a duplicate route.
            expect(
                defImport.startsWith('$lib/'),
                `${name} imports its def via a relative path (or an unrecognised form) instead of $lib/...`,
            ).toBe(true);
        },
    );

    it.each(routes)(
        'mounts its def with correct v1 docs metadata: $name',
        async ({ name, file, defImport }) => {
            const specifier = resolveDefSpecifier(file, defImport);
            const mod = (await import(/* @vite-ignore */ specifier)) as {
                def: {
                    docs?: Record<string, unknown> & { visibility?: string };
                    docsByPath?: (
                        openApiPath: string,
                    ) => (Record<string, unknown> & { visibility?: string }) | undefined;
                };
            };

            // A def mounted at more than one path (e.g. pinned-genres split across
            // the collection and `/{genre}`) supplies `docsByPath` instead of a flat
            // `docs`. Ask it for THIS route's own path, exactly as the real
            // generator does, so each mount is checked against the metadata it will
            // actually be published with — not some other mount's.
            const openApiPath = routeFileToOpenApiPath(file);
            const docs = mod.def.docsByPath ? mod.def.docsByPath(openApiPath) : mod.def.docs;
            expect(
                docs,
                `${name}: ${defImport} has no docs for path ${openApiPath} (neither \`docs\` nor a \`docsByPath\` returning metadata for it)`,
            ).toBeDefined();

            expect(docs?.visibility, `${name}: docs.visibility must not be 'internal'`).not.toBe(
                'internal',
            );

            const { visibility: _visibility, ...methodEntries } = docs ?? {};
            for (const [method, meta] of Object.entries(methodEntries)) {
                const methodMeta = meta as Record<string, unknown>;
                expect(methodMeta.stability, `${name} ${method} stability`).toBeDefined();
                expect(methodMeta.auth, `${name} ${method} auth`).toBe('bearer');
            }
        },
    );
});

describe('the smart-download endpoints are reachable', () => {
    // A def is NOT auto-mounted. Without these two files both endpoints return
    // 404 while looking complete in the def tree, typechecking clean and
    // passing every unit test. This exact omission shipped once.
    it.each([
        'src/routes/api/v1/series/downloads/candidates/+server.ts',
        'src/routes/api/v1/series/downloads/rescore/+server.ts',
    ])('%s exists and mounts a def on the v1 surface', (relPath) => {
        const file = join(repoRoot, relPath);
        const src = readFileSync(file, 'utf8');
        expect(src).toContain("surface: 'v1'");
        expect(src).toMatch(/from\s+'\$lib\/server\/api\/defs\/series\/downloads\//);
    });

    it('publishes both as beta, since /api/v1/series is in STABLE_PREFIXES', async () => {
        for (const mod of ['candidates', 'rescore']) {
            const { def } = (await import(
                /* @vite-ignore */ `$lib/server/api/defs/series/downloads/${mod}.js`
            )) as { def: { docs?: Record<string, { stability?: string }> } };
            const methods = Object.entries(def.docs ?? {}).filter(([k]) => k !== 'visibility');
            expect(methods.length, `${mod} declares no methods`).toBeGreaterThan(0);
            for (const [method, meta] of methods) {
                expect(meta.stability, `${mod} ${method}`).toBe('beta');
            }
        }
    });
});
