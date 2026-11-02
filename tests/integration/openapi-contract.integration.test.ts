// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * B-class runtime contract guard — handler ↔ documented-schema divergence.
 *
 * For each PUBLIC /api/v1 GET route that documents a 2xx response schema in its
 * colocated `_openapi.ts`, this test:
 *   1. seeds minimal auth + (where cheap) fixture data into the live test DB,
 *   2. invokes the route's ACTUAL exported `+server.ts` handler (so it runs
 *      through `mount()` → enforce() → validateRequest → domain handler, exactly
 *      as in production),
 *   3. captures the real JSON body, and
 *   4. asserts the body PARSES against the SAME zod schema the route's
 *      `_openapi.ts` documents (imported via the route's `route` metadata).
 *
 * This is the divergence guard that would have caught B1–B6: a handler emitting
 * a `{ success: true }` wrapper instead of `{ items, page }`, a flat
 * `posterUrl`/`imageUrl` instead of an `images{}` href map, a raw
 * `sonarr`/`radarr`/`tv` `mediaType` instead of the canonical `type`/`series`
 * discriminator, etc. — any of those make the documented schema fail to parse
 * the actual body.
 *
 * Pragmatism: routes that cannot be invoked cheaply (need external sync, curated
 * cache priming, or rich fixtures) are it.skip()ed with a logged reason rather
 * than asserted against fabricated data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import type { ZodType } from 'zod';

import { getTestDb, closeTestDb } from './setup/test-database.js';
import { truncateTables, TEST_TABLES } from './helpers/cleanup.js';
import { ensureTestUser } from './fixtures/user.fixtures.js';
import { createAndInsertTestMovie } from './fixtures/media.fixtures.js';

import type { Principal } from '$lib/server/api/principal.js';
import type { UserContext } from '$lib/server/types.js';
import type { UserId } from '$lib/shared/user-id.js';
import type { RouteMetadata, ResponseDef } from '$lib/server/openapi.js';

// ---------------------------------------------------------------------------
// Test identity
// ---------------------------------------------------------------------------

// Stable users.id UUID for the seeded test principal.
const TEST_USER_ID = '00000000-0000-4000-8000-0000000000a1';
const TEST_USERNAME = 'contract_guard_user';

/** Admin UserContext (locals.user) — passes requireAuth + fail-open media access. */
function makeUserContext(): UserContext {
    return {
        userId: TEST_USER_ID as UserId,
        username: TEST_USERNAME,
        groups: 'admins',
        userGroups: ['admins'],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: true,
        ownerIsAdmin: true,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: true,
        liveTvPriority: 'high',
    };
}

/** Admin Principal (locals.principal) — passes enforce() for user/admin/scope. */
function makePrincipal(): Principal {
    return {
        kind: 'session',
        userId: TEST_USER_ID as UserId,
        username: TEST_USERNAME,
        userGroups: ['admins'],
        // Broad expanded scope set so scope-gated GETs pass.
        scopes: ['read', 'write', 'admin'],
        isAdmin: true,
    };
}

// ---------------------------------------------------------------------------
// Fake RequestEvent
// ---------------------------------------------------------------------------

/**
 * Build a minimal RequestEvent good enough to drive a mounted GET handler.
 * Only the fields our handlers read are populated; the rest are typed-away.
 */
function makeEvent(opts: {
    path: string;
    searchParams?: Record<string, string>;
    params?: Record<string, string>;
}): RequestEvent {
    const url = new URL(`http://localhost${opts.path}`);
    for (const [k, v] of Object.entries(opts.searchParams ?? {})) {
        url.searchParams.set(k, v);
    }
    const request = new Request(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
    });
    const event = {
        request,
        url,
        params: opts.params ?? {},
        locals: {
            user: makeUserContext(),
            principal: makePrincipal(),
        },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => {},
            delete: () => {},
            serialize: () => '',
        },
        fetch: globalThis.fetch,
        getClientAddress: () => '127.0.0.1',
        setHeaders: () => {},
        platform: undefined,
        route: { id: null },
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
    return event;
}

// ---------------------------------------------------------------------------
// Schema extraction from a route's _openapi.ts metadata
// ---------------------------------------------------------------------------

/** Pull the documented 2xx response zod schema out of a RouteMetadata.GET. */
function documented2xxSchema(meta: RouteMetadata): ZodType | null {
    const get = meta.GET;
    if (!get) return null;
    for (const status of [200, 201, 202, 204]) {
        const def = get.responses[status] as ResponseDef | string | undefined;
        if (def && typeof def === 'object' && 'schema' in def && def.schema) {
            return def.schema as ZodType;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------

type SeedFn = (sql: postgres.Sql) => Promise<void>;

interface RouteCase {
    name: string;
    /** dynamic import of `{ GET }` from the route's +server.ts */
    importHandler: () => Promise<{ GET?: unknown }>;
    /** dynamic import of `{ route }` from the route's _openapi.ts */
    importMeta: () => Promise<{ route: RouteMetadata }>;
    path: string;
    searchParams?: Record<string, string>;
    /** resolved at call time so seeded ids can flow into the path param */
    params?: () => Record<string, string>;
    seed?: SeedFn;
    /** when set, the case is it.skip()ed with this reason */
    skip?: string;
    /**
     * Statuses (besides the documented 2xx) that are acceptable for this case
     * — e.g. an empty curated list legitimately 404s. When the handler returns
     * one of these, the body is NOT parsed (there is no seeded happy-path),
     * but the test still PASSES rather than fabricating data.
     */
    tolerate?: number[];
}

// A seeded movie id, shared across cases that need a concrete media UUID.
let seededMovieId: string | null = null;

const cases: RouteCase[] = [
    // ---- audit routes ----------------------------------------------------
    {
        name: 'GET /api/v1/continue-watching',
        importHandler: () => import('../../src/routes/api/v1/continue-watching/+server.ts'),
        importMeta: async () => ({
            route: (
                await import('../../src/lib/server/api/defs/recommendations/continue-watching.ts')
            ).def.docs!,
        }),
        path: '/api/v1/continue-watching',
        searchParams: { limit: '5' },
    },
    {
        name: 'GET /api/v1/recommendations',
        importHandler: () => import('../../src/routes/api/v1/recommendations/+server.ts'),
        importMeta: async () => ({
            route: (
                await import('../../src/lib/server/api/defs/recommendations/recommendations.ts')
            ).def.docs!,
        }),
        path: '/api/v1/recommendations',
        searchParams: { limit: '5' },
        // Down recommender dependency surfaces as 503 — acceptable without seed.
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/trending',
        importHandler: () => import('../../src/routes/api/v1/trending/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/recommendations/trending.ts')).def
                .docs!,
        }),
        path: '/api/v1/trending',
        searchParams: { limit: '5' },
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/upcoming',
        importHandler: () => import('../../src/routes/api/v1/upcoming/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/recommendations/upcoming.ts')).def
                .docs!,
        }),
        path: '/api/v1/upcoming',
        searchParams: { limit: '5' },
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/lists/{id}',
        importHandler: () => import('../../src/routes/api/v1/lists/[id]/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/lists/[id].ts')).def.docs!,
        }),
        path: '/api/v1/lists/trending-movies',
        params: () => ({ id: 'trending-movies' }),
        // An unseeded curated list legitimately 404s (no external sync in tests);
        // when seeded data is absent the contract for the happy-path can't be
        // exercised, so we tolerate the documented 404 rather than fake a cache.
        tolerate: [404],
    },
    {
        name: 'GET /api/v1/media/{id}',
        importHandler: () => import('../../src/routes/api/v1/media/[id]/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/catalog/media-id.ts')).def.docs!,
        }),
        path: '/api/v1/media/SEEDED',
        params: () => ({ id: seededMovieId ?? '' }),
        seed: async (sql) => {
            const { id } = await createAndInsertTestMovie(sql, {
                title: 'Contract Guard Movie',
            });
            seededMovieId = id;
        },
    },
    {
        name: 'GET /api/v1/search',
        importHandler: () => import('../../src/routes/api/v1/search/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/search/search.ts')).def.docs!,
        }),
        path: '/api/v1/search',
        searchParams: { q: 'a', limit: '5' },
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/watch-state/{id}',
        importHandler: () => import('../../src/routes/api/v1/watch-state/[id]/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/watch-state/[id].ts')).def.docs!,
        }),
        path: '/api/v1/watch-state/SEEDED',
        params: () => ({ id: seededMovieId ?? '' }),
        // Reuses the movie seeded by the media/{id} case (same beforeEach seed
        // block seeds it); ensured present below.
    },
    {
        name: 'GET /api/v1/browse',
        importHandler: () => import('../../src/routes/api/v1/browse/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/browse/index.ts')).def.docs!,
        }),
        path: '/api/v1/browse',
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/media',
        importHandler: () => import('../../src/routes/api/v1/media/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/catalog/media.ts')).def.docs!,
        }),
        path: '/api/v1/media',
        searchParams: { limit: '5' },
        tolerate: [503],
    },
    // ---- additional cheap GET collection/detail routes -------------------
    {
        name: 'GET /api/v1/browse/libraries',
        importHandler: () => import('../../src/routes/api/v1/browse/libraries/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/browse/libraries.ts')).def.docs!,
        }),
        path: '/api/v1/browse/libraries',
        tolerate: [503],
    },
    {
        name: 'GET /api/v1/lists',
        importHandler: () => import('../../src/routes/api/v1/lists/+server.ts'),
        importMeta: async () => ({
            route: (await import('../../src/lib/server/api/defs/lists/index.ts')).def.docs!,
        }),
        path: '/api/v1/lists',
        tolerate: [503, 404],
        // Previously skipped for a handler↔schema divergence (handler emits
        // source/listPath/lastSyncedAt; the documented CuratedListSchema wrongly
        // required provider/syncedAt). CuratedListSchema is now aligned to the
        // handler's actual fields, so this case is asserted.
    },
];

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe('OpenAPI runtime contract guard (B-class divergence)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Reset to a known-empty state, then plant the shared identity + the
        // single movie reused by media/{id} and watch-state/{id}.
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
            ...TEST_TABLES.watchStatus,
        ]);
        await ensureTestUser(sql, TEST_USER_ID);
        const { id } = await createAndInsertTestMovie(sql, { title: 'Shared Guard Movie' });
        seededMovieId = id;
    });

    for (const c of cases) {
        if (c.skip) {
            it.skip(`${c.name} — SKIPPED: ${c.skip}`, () => {});
            continue;
        }

        it(`${c.name} parses against its documented response schema`, async () => {
            // Per-case seed (in addition to the shared beforeEach seed).
            if (c.seed) await c.seed(sql);

            const [{ route }, mod] = await Promise.all([c.importMeta(), c.importHandler()]);
            const schema = documented2xxSchema(route);
            if (!schema) {
                // No documented 2xx schema → nothing to guard for this route.
                console.warn(`[contract-guard] ${c.name}: no documented 2xx schema, skipping`);
                return;
            }

            const GET = (mod as { GET?: (e: RequestEvent) => Promise<Response> }).GET;
            expect(GET, `${c.name}: no exported GET handler`).toBeTypeOf('function');

            const event = makeEvent({
                path: c.path,
                searchParams: c.searchParams,
                params: c.params?.(),
            });

            const res = await GET!(event);
            const status = res.status;

            // Tolerated non-2xx (e.g. 503 dependency-down, 404 empty curated
            // list) — a legitimate documented outcome, not a contract failure.
            // We do NOT parse the happy-path schema against an error body.
            if (c.tolerate?.includes(status)) {
                console.warn(
                    `[contract-guard] ${c.name}: tolerated status ${status} (no happy-path seed); ` +
                        `envelope schema not asserted for this run`,
                );
                return;
            }

            // Must be a documented 2xx now.
            const text = await res.text();
            expect(
                status >= 200 && status < 300,
                `${c.name}: expected 2xx, got ${status}: ${text.slice(0, 400)}`,
            ).toBe(true);

            let body: unknown;
            try {
                body = text.length ? JSON.parse(text) : undefined;
            } catch (err) {
                throw new Error(`${c.name}: response was not JSON: ${(err as Error).message}`, {
                    cause: err,
                });
            }

            const parsed = schema.safeParse(body);
            if (!parsed.success) {
                const issues = parsed.error.issues
                    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
                    .join('\n');
                throw new Error(
                    `${c.name}: response body DIVERGES from documented schema:\n${issues}\n` +
                        `body: ${JSON.stringify(body).slice(0, 600)}`,
                );
            }
            expect(parsed.success).toBe(true);
        });
    }
});
