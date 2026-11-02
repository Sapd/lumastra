// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Coverage guard for `docsByPath` defs.
 *
 * mount()'s response-conformance gate resolves a def's response schema by
 * converting `event.route.id` to the OpenAPI `{param}` form and asking
 * `def.docsByPath()` for that path. The gate is therefore only as good as that
 * string agreeing with what the def's predicate matches on — a def whose
 * predicate silently fails to claim one of its mounted route ids gets NO
 * response validation on that mount, and nothing else would notice.
 *
 * This file asserts, for every def in the repo that uses `docsByPath`, the
 * EXACT string mount() will hand it at each real mount, and whether that mount
 * is gated (schema resolved) or deliberately opted out.
 *
 * ADDING A NEW `docsByPath` DEF? Add it to MOUNTS below. The final test fails
 * loudly if a def grows a `docsByPath` without being listed here — that is what
 * stops the old "docsByPath bypasses the gate" blind spot from re-forming under
 * a different name.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { routeIdToOpenApiPath } from './mount.js';
import { def as pinnedGenresDef } from './defs/user/music/pinned-genres.js';
import { def as episodesDef } from './defs/catalog/series/episodes.js';
import { def as seasonsDef } from './defs/catalog/series/seasons.js';
import { def as feedDef } from './defs/recommendations/feed.js';

const ROOT = resolve(__dirname, '../../../..');

type Mount = {
    /** SvelteKit route id — what `event.route.id` holds at request time. */
    routeId: string;
    /** The `{param}`-form path mount() derives from it. */
    openApiPath: string;
    def: { docsByPath?: (p: string) => unknown };
    /** Methods expected to resolve a 200 response schema on this mount. */
    gated: string[];
};

const MOUNTS: Mount[] = [
    {
        routeId: '/api/feed',
        openApiPath: '/api/feed',
        def: feedDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/v1/feed',
        openApiPath: '/api/v1/feed',
        def: feedDef,
        gated: ['GET'],
    },
    // defs/user/music/pinned-genres.ts — three mounts, two shapes.
    {
        routeId: '/api/v1/me/music/pinned-genres',
        openApiPath: '/api/v1/me/music/pinned-genres',
        def: pinnedGenresDef,
        gated: ['GET', 'POST'],
    },
    {
        routeId: '/api/v1/me/music/pinned-genres/[genre]',
        openApiPath: '/api/v1/me/music/pinned-genres/{genre}',
        def: pinnedGenresDef,
        gated: ['DELETE'],
    },
    {
        routeId: '/api/me/music/pinned-genres',
        openApiPath: '/api/me/music/pinned-genres',
        def: pinnedGenresDef,
        gated: ['GET', 'POST', 'DELETE'],
    },
    // Series traversal mounts share the new response contracts on both surfaces.
    {
        routeId: '/api/v1/series/[id]/seasons',
        openApiPath: '/api/v1/series/{id}/seasons',
        def: seasonsDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/v1/series/[id]/seasons/[n]',
        openApiPath: '/api/v1/series/{id}/seasons/{n}',
        def: seasonsDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/series/[id]/seasons',
        openApiPath: '/api/series/{id}/seasons',
        def: seasonsDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/v1/seasons/[id]',
        openApiPath: '/api/v1/seasons/{id}',
        def: seasonsDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/series/[id]/episodes',
        openApiPath: '/api/series/{id}/episodes',
        def: episodesDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/v1/series/[id]/episodes',
        openApiPath: '/api/v1/series/{id}/episodes',
        def: episodesDef,
        gated: ['GET'],
    },
    {
        routeId: '/api/v1/series/[id]/seasons/[n]/episodes/[e]',
        openApiPath: '/api/v1/series/{id}/seasons/{n}/episodes/{e}',
        def: episodesDef,
        gated: ['GET'],
    },
];

describe('routeIdToOpenApiPath', () => {
    it.each([
        ['/api/v1/me/music/pinned-genres', '/api/v1/me/music/pinned-genres'],
        ['/api/v1/me/music/pinned-genres/[genre]', '/api/v1/me/music/pinned-genres/{genre}'],
        ['/api/v1/series/[id]/seasons/[n]', '/api/v1/series/{id}/seasons/{n}'],
        ['/api/v1/media/[...path]', '/api/v1/media/{path}'],
    ])('%s → %s', (routeId, expected) => {
        expect(routeIdToOpenApiPath(routeId)).toBe(expected);
    });

    it('mirrors the generator byte-for-byte on route ids it derives from file paths', () => {
        // filePathToOpenApiPath() takes dirname(rel) and maps the SAME two
        // bracket forms. Reproduce it here and cross-check on every real
        // mounted route directory, so a future divergence is caught.
        const generatorForm = (dir: string): string =>
            '/' +
            dir
                .split('/')
                .map((seg) => {
                    if (seg.startsWith('[...') && seg.endsWith(']')) return `{${seg.slice(4, -1)}}`;
                    if (seg.startsWith('[') && seg.endsWith(']')) return `{${seg.slice(1, -1)}}`;
                    return seg;
                })
                .join('/');

        for (const { routeId } of MOUNTS) {
            expect(routeIdToOpenApiPath(routeId)).toBe(generatorForm(routeId.slice(1)));
        }
    });
});

describe('docsByPath defs are reachable at every route they are mounted on', () => {
    it.each(MOUNTS)(
        '$routeId resolves the docs mount() will use',
        ({ routeId, openApiPath, def, gated }) => {
            // 1. mount() derives exactly this path from the route id.
            expect(routeIdToOpenApiPath(routeId)).toBe(openApiPath);

            // 2. The def's own predicate claims (or deliberately declines) it.
            const docs = def.docsByPath?.(openApiPath) as
                Record<string, { responses?: Record<number, unknown> } | undefined> | undefined;

            if (gated.length === 0) {
                expect(docs).toBeUndefined();
                return;
            }

            expect(docs).toBeDefined();
            // 3. Every method expected to be gated resolves a 200 response WITH a
            //    schema — that object is precisely what inspectResponse reads.
            for (const method of gated) {
                const res200 = docs?.[method]?.responses?.[200];
                expect(res200, `${routeId} ${method} 200`).toBeDefined();
                expect(res200, `${routeId} ${method} 200 must carry a schema`).toHaveProperty(
                    'schema',
                );
            }
            // 4. Methods NOT listed must be absent, or the generated spec would
            //    advertise phantom operations on this path (the original reason
            //    this def uses docsByPath at all).
            for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
                if (!gated.includes(method)) {
                    expect(
                        docs?.[method],
                        `${routeId} must not document ${method}`,
                    ).toBeUndefined();
                }
            }
        },
    );

    it('every def using docsByPath in the repo is listed in MOUNTS', () => {
        const defsDir = resolve(ROOT, 'src/lib/server/api/defs');
        const found: string[] = [];
        for (const entry of readdirSync(defsDir, { withFileTypes: true, recursive: true })) {
            if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
            const dir = entry.parentPath ?? (entry as unknown as { path: string }).path;
            const file = join(dir, entry.name);
            if (/\bdocsByPath\s*:/.test(readFileSync(file, 'utf-8'))) {
                found.push(relative(ROOT, file));
            }
        }
        expect(
            found.sort(),
            'A def grew a `docsByPath` without being added to MOUNTS in this file. Add its ' +
                'mounts here so its runtime response-conformance coverage is pinned — an ' +
                'unlisted def can silently lose the gate on a mount its predicate fails to claim.',
        ).toEqual([
            'src/lib/server/api/defs/catalog/series/episodes.ts',
            'src/lib/server/api/defs/catalog/series/seasons.ts',
            'src/lib/server/api/defs/recommendations/feed.ts',
            'src/lib/server/api/defs/user/music/pinned-genres.ts',
        ]);
    });
});
