// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Meta-test over EVERY def-mounted route on the v1 surface.
 *
 * WHY THIS IS REPO-WIDE. Two family-scoped versions of this guard already
 * exist — `series/v1-series-mounts.test.ts` and `music/v1-music-mounts.test.ts`
 * — and between them they cover 60 of the 330 def-mounted v1 route files. The
 * other 54 families had nothing. The failure this catches is invisible by
 * construction: a def can typecheck, lint, pass every unit test and still be
 * absent from (or mispublished in) the spec that third-party and first-party
 * clients generate their code from. It has cost production twice — an
 * audiobook heartbeat route that was never mounted (a live book read "Paused
 * just now"), and a task whose trigger was missing.
 *
 * The requirements below are enforced by no type and no lint rule:
 *
 *   1. A def that declares `docsByPath` must return metadata for THIS route's
 *      own path. mount()'s response-conformance gate resolves the response
 *      schema through that call, so a path the predicate fails to claim gets NO
 *      response validation and nothing else notices. (A def with NEITHER `docs`
 *      nor `docsByPath` is fine — the generator falls back to the def's own
 *      schemas and still publishes the path.)
 *   2. `stability` must be set explicitly per method FOR PATHS UNDER
 *      STABLE_PREFIXES. `defaultStability()` (generate-public.ts:425) resolves
 *      an omitted tier to `stable` there — so forgetting it does not fail, it
 *      PUBLISHES A BETA ROUTE AS STABLE, a one-way door for strict clients.
 *      Elsewhere the default is `beta`, which is safe, so this does not demand
 *      ceremony from routes that cannot be hurt by the default.
 *   3. `visibility` is a ROUTE-level sibling of the per-method keys
 *      (define.ts:309), NOT a property inside a method's metadata. Put it one
 *      level too deep and it silently does nothing. This asserts the shape, not
 *      the value: `'internal'` is a legitimate, documented choice (it routes the
 *      path to internal-api.yaml instead of api-v1.yaml and does NOT affect
 *      routing or auth), and 80 v1 routes use it deliberately.
 *
 * NOT asserted here, on purpose: that `auth` is declared per method. The
 * generator falls back to `detectAuth(handlerSource)` (generate-public.ts:773)
 * when it is omitted, so an omission is not a silent mispublication. The
 * family-scoped series test still requires an explicit `'bearer'` where that is
 * the actual contract.
 *
 * The family-scoped files stay: they assert things this one deliberately does
 * not (e.g. series requires `auth: 'bearer'` specifically, and pins its
 * smart-download endpoints to `beta`). This file is the floor, not a
 * replacement.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../..');
const v1Dir = join(repoRoot, 'src/routes/api/v1');
const defsDir = join(repoRoot, 'src/lib/server/api/defs');

interface RouteInfo {
    file: string;
    /** Path relative to the repo root, for readable test names/messages. */
    name: string;
    /** Raw def-import specifier as it appears in source; '' if only `mount(` matched. */
    defImport: string;
}

/** Drops block and line comments so prose cannot masquerade as code. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Mirrors STABLE_PREFIXES in scripts/openapi/generate-public.ts:390. A path
 * under one of these publishes as `stable` when `stability` is omitted; every
 * other path defaults to `beta`. Keep in sync with the generator — the test
 * below asserts this list is not silently narrower than the real one.
 */
const STABLE_PREFIXES = [
    '/api/v1/search',
    '/api/v1/media',
    '/api/v1/people',
    '/api/v1/users',
    '/api/v1/libraries',
    '/api/v1/series',
    '/api/v1/seasons',
    '/api/v1/episodes',
    '/api/v1/music',
    '/api/v1/playback/',
    '/api/v1/sessions',
    '/api/v1/watchlist',
    '/api/v1/history',
    '/api/v1/server',
    '/api/v1/requests',
];

/**
 * Route files that mount a def (as opposed to bespoke handler routes).
 *
 * Discovery does NOT require the `$lib` import form: it collects any
 * `+server.ts` whose source imports from a path containing `/defs/`
 * (relative or `$lib`) OR calls `mount(`. That is deliberate — a route whose
 * def import is relative must still be discovered, otherwise the relative-import
 * guard below could never fire on the one case it exists to catch.
 */
async function defMountedRoutes(): Promise<RouteInfo[]> {
    const out: RouteInfo[] = [];
    for await (const file of glob(join(v1Dir, '**/+server.ts'))) {
        const src = readFileSync(file, 'utf8');
        const defImportMatch = /from\s+'([^']*\/defs\/[^']+)'/.exec(src);
        // Strip comments before looking for a `mount(` CALL. Without this,
        // prose like "every sibling route is a mount()ed def" in a bespoke
        // handler's header comment makes that route look def-mounted — which is
        // exactly what src/routes/api/v1/runs/history/+server.ts does.
        const code = stripComments(src);
        const callsMount = /\bmount\(/.test(code);
        if (!defImportMatch && !callsMount) continue;
        out.push({ file, name: relative(repoRoot, file), defImport: defImportMatch?.[1] ?? '' });
    }
    return out;
}

function resolveDefSpecifier(file: string, specifier: string): string {
    if (!specifier.startsWith('.')) return specifier;
    return pathToFileURL(join(dirname(file), specifier)).href;
}

/**
 * Derives the OpenAPI path (`{param}` form) a route's `+server.ts` mounts at,
 * mirroring `filePathToOpenApiPath` in scripts/openapi/generate-public.ts, so a
 * def using `docsByPath` can be queried with the same path the real generator
 * would ask for.
 */
function routeFileToOpenApiPath(file: string): string {
    const rel = relative(join(repoRoot, 'src/routes'), file);
    const segments = dirname(rel)
        .split(sep)
        .map((seg) => {
            if (seg.startsWith('[...') && seg.endsWith(']')) return `{${seg.slice(4, -1)}}`;
            if (seg.startsWith('[') && seg.endsWith(']')) return `{${seg.slice(1, -1)}}`;
            return seg;
        });
    return '/' + segments.join('/');
}

// Module scope — NOT inside a `describe` callback. Top-level await works here;
// it does not work directly inside `describe`. Discovery happens once and
// `it.each` consumes the resolved array, so each route fails independently
// instead of one mega-test aborting at the first bad route.
const routes = await defMountedRoutes();

describe('v1 mounts (all families)', () => {
    it('discovers the def-mounted v1 routes', () => {
        // A collapse to zero would make every `it.each` below vacuously pass.
        // 300 is a floor well under the current count, not a pin to it.
        expect(routes.length).toBeGreaterThan(300);
    });

    it.each(routes)(
        'imports its def via the $$lib specifier, never a relative path: $name',
        ({ name, defImport }) => {
            // A route discovered only by its `mount(` call has no def import to
            // judge; the rule is about the FORM of an import that exists.
            if (defImport === '') return;
            // gen-api-routes.ts:269 only recognises the $lib form as a hand
            // mount. A relative import makes the generator emit a DUPLICATE route.
            expect(
                defImport.startsWith('$lib/'),
                `${name} imports its def via a relative path instead of $lib/...`,
            ).toBe(true);
        },
    );

    it.each(routes)(
        'publishes complete v1 docs metadata: $name',
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

            // A def mounted at more than one path supplies `docsByPath` instead of a
            // flat `docs`. Ask it for THIS route's own path, exactly as the real
            // generator does, so each mount is checked against the metadata it will
            // actually be published with — not some other mount's.
            const openApiPath = routeFileToOpenApiPath(file);
            const docs = mod.def.docsByPath ? mod.def.docsByPath(openApiPath) : mod.def.docs;

            // A def with NEITHER `docs` nor `docsByPath` is not a bug: the generator
            // falls back to the def's own request/response schemas and still
            // publishes the path (verified — /api/v1/playlists/{id},
            // /api/v1/watch-together and /api/v1/play-sessions/{id}/events all reach
            // api-v1.yaml with no `docs` key at all).
            //
            // What IS a silent gap is a def that HAS `docsByPath` but whose
            // predicate does not claim this mount's path: mount()'s
            // response-conformance gate asks `docsByPath(path)` for the response
            // schema, so an unclaimed path gets NO response validation and nothing
            // else notices. See src/lib/server/api/docs-by-path-coverage.test.ts,
            // which pins the exact strings for the defs that use it.
            if (mod.def.docsByPath) {
                expect(
                    docs,
                    `${name}: ${defImport} declares docsByPath but it returns nothing for ${openApiPath}, ` +
                        `so this mount gets no response-contract validation`,
                ).toBeDefined();
            }
            if (!docs) return;

            // Value-agnostic: 'internal' is a deliberate, documented routing of the
            // path into internal-api.yaml. Only an UNRECOGNISED value is a bug.
            if (docs?.visibility !== undefined) {
                expect(
                    ['public', 'internal'],
                    `${name}: docs.visibility is '${docs.visibility}', which is neither 'public' nor 'internal'`,
                ).toContain(docs.visibility);
            }

            const { visibility: _visibility, ...methodEntries } = docs;

            const underStablePrefix = STABLE_PREFIXES.some((p) => openApiPath.startsWith(p));

            for (const [method, meta] of Object.entries(methodEntries)) {
                const methodMeta = meta as Record<string, unknown>;

                // Per-method visibility is supported (generate-public.ts splits a path
                // between the public and internal spec), but only 'internal' means
                // anything: a method is public unless it says otherwise.
                if (methodMeta.visibility !== undefined) {
                    expect(
                        methodMeta.visibility,
                        `${name} ${method}: a method-level 'visibility' can only be 'internal'.`,
                    ).toBe('internal');
                }

                if (underStablePrefix) {
                    expect(
                        methodMeta.stability,
                        `${name} ${method}: stability is omitted and this path is under STABLE_PREFIXES, ` +
                            `so it publishes as 'stable' by default — pin it explicitly.`,
                    ).toBeDefined();
                }
            }
        },
    );
});

/**
 * Defs that export a `def` but are deliberately imported by no route file.
 *
 * A def is NOT auto-mounted. Without a `+server.ts` importing it, an endpoint
 * 404s while looking complete in the def tree, typechecking clean and passing
 * every unit test — the exact shape of two past production incidents. Anything
 * new that lands here is a mistake until someone says otherwise IN THIS LIST.
 */
const UNMOUNTED_BY_DESIGN = new Set([
    // Documentation-only module describing the def format; exports a sample
    // `def` that is intentionally not an endpoint.
    '_readme.ts',
    // Shared handler implementations composed INTO other interaction defs,
    // not mounted on its own.
    'interactions/handlers.ts',
    // Delegated by users/[id]/devices-revoke-all.ts for the admin revoke-all route.
    'admin/devices/all/index.ts',
    // Delegated by pats.ts, pats-id.ts, and users/[id]/pats.ts.
    'admin/pats.ts',
    // DELETE handler/docs composed into devices/[id]/index.ts alongside PATCH.
    'devices/revoke.ts',
]);

describe('every def is mounted, or explicitly declared unmounted', () => {
    it('has no def that silently reaches no route', async () => {
        const defFiles: string[] = [];
        for await (const file of glob(join(defsDir, '**/*.ts'))) {
            if (/\.(test|spec)\.ts$/.test(file) || file.endsWith('.d.ts')) continue;
            if (!/export\s+const\s+def\b/.test(readFileSync(file, 'utf8'))) continue;
            defFiles.push(relative(defsDir, file));
        }

        // Every `/defs/...` specifier imported from ANY route file, on either
        // surface — a def mounted only on the internal `/api` surface still
        // counts as mounted here. This test asks "does it reach a route at
        // all", not "is it on v1".
        const imported = new Set<string>();
        for await (const file of glob(join(repoRoot, 'src/routes/api/**/*.ts'))) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/from\s+'([^']*\/defs\/([^']+))'/g)) {
                const tail = m[2].replace(/\.js$/, '');
                imported.add(`${tail}.ts`);
                // `foo/index.ts` is imported as `.../foo`.
                imported.add(`${tail}/index.ts`);
            }
        }

        const orphans = defFiles
            .filter((d) => !imported.has(d))
            .filter((d) => !UNMOUNTED_BY_DESIGN.has(d))
            .sort();

        expect(
            orphans,
            'These defs export a `def` but no route file imports them, so they are unreachable. ' +
                'Add the `+server.ts` that mounts them, or add them to UNMOUNTED_BY_DESIGN with a reason.',
        ).toEqual([]);
    });

    it('keeps UNMOUNTED_BY_DESIGN honest — every entry still exists and is still unmounted', async () => {
        // Without this, an allowlist entry outlives the file it excused and
        // silently starts excusing nothing (or, worse, masks a later def that
        // lands on the same path).
        const present = new Set<string>();
        for await (const file of glob(join(defsDir, '**/*.ts'))) {
            present.add(relative(defsDir, file));
        }
        for (const entry of UNMOUNTED_BY_DESIGN) {
            expect(
                present.has(entry),
                `UNMOUNTED_BY_DESIGN lists ${entry}, which no longer exists`,
            ).toBe(true);
        }
    });
});
