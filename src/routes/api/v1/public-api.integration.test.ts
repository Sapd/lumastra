// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Public API Integration Contract Tests
 *
 * Integration contract tests for /api/v1 token-surface routes:
 * - browse, search, media/[id], series/[id]/episodes, continue-watching
 *
 * Focus: shape + status + access scoping against lumastra_tests DB.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import type { RequestEvent } from '@sveltejs/kit';

vi.hoisted(() => {
    const testUrl =
        process.env.TEST_DATABASE_URL ||
        process.env.DATABASE_URL?.replace(/\/[^/]*$/, '/lumastra_tests') ||
        'postgres://localhost:5432/lumastra_tests';
    process.env.TEST_DATABASE_URL = testUrl;
    process.env.DATABASE_URL = testUrl;
});

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => getTestDb(),
    getTaskDb: () => getTestDb(),
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('Public API contract tests', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM external_ids WHERE media_id IN (
            SELECT id FROM media_items WHERE title LIKE 'ES4 Contract%'
        )`;
        await sql`DELETE FROM provider_metadata WHERE media_id IN (
            SELECT id FROM media_items WHERE title LIKE 'ES4 Contract%'
        )`;
        await sql`DELETE FROM user_media_state WHERE user_id IN (
            SELECT id FROM users WHERE username LIKE 'es4-%'
        )`;
        await sql`DELETE FROM media_items WHERE title LIKE 'ES4 Contract%'`;
        await sql`DELETE FROM users WHERE username LIKE 'es4-%'`;
        vi.clearAllMocks();
    });

    async function insertUser(
        opts: {
            username?: string;
            ageRestricted?: boolean;
            maxAgeRating?: number;
        } = {},
    ) {
        const id = crypto.randomUUID();
        const username = opts.username ?? `es4-${id.slice(0, 8)}`;
        await sql`
            INSERT INTO users (id, username, is_admin, max_age_rating)
            VALUES (${id}::uuid, ${username}, false, ${opts.maxAgeRating ?? null})
        `;
        return {
            id,
            userId: id,
            username,
            isAdmin: false,
            isAgeRestricted: opts.ageRestricted ?? false,
            maxAgeRating: opts.maxAgeRating ?? null,
        };
    }

    async function insertMovie(overrides: Record<string, unknown> = {}) {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, age_rating, year, created_at
            ) VALUES (
                ${id}::uuid, ${'movie'},
                ${(overrides.title as string) ?? 'ES4 Contract Movie'},
                ${(overrides.overview as string) ?? 'Overview'},
                ${'active'},
                ${(overrides.hasFiles as boolean) ?? true},
                ${(overrides.ageRating as number) ?? null},
                ${(overrides.year as number) ?? 2024},
                NOW()
            )
        `;
        return id;
    }

    async function insertSeriesWithEpisodes() {
        const seriesId = crypto.randomUUID();
        const seasonId = crypto.randomUUID();
        const episodeId = crypto.randomUUID();
        const episode2Id = crypto.randomUUID();

        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, created_at
            ) VALUES (
                ${seriesId}::uuid, ${'tv'},
                ${'ES4 Contract Series'},
                ${'Series overview'},
                ${'active'},
                true,
                NOW()
            )
        `;

        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, parent_id, season_number, created_at
            ) VALUES (
                ${seasonId}::uuid, ${'season'},
                ${'Season 1'},
                ${'Season overview'},
                ${'active'},
                true,
                ${seriesId}::uuid,
                1,
                NOW()
            )
        `;

        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, parent_id, season_number, episode_number,
                runtime_seconds, created_at
            ) VALUES (
                ${episodeId}::uuid, ${'episode'},
                ${'Pilot'},
                ${'Episode overview'},
                ${'active'},
                true,
                ${seasonId}::uuid,
                1,
                1,
                3600,
                NOW()
            )
        `;

        // A second episode in the SAME season (S1E2) so coordinate-resolution
        // tests can prove distinctness — ?episode=1 vs ?episode=2 must return
        // different episode nodes, not just "an episode".
        await sql`
            INSERT INTO media_items (
                id, media_type, title, overview, status,
                has_files, parent_id, season_number, episode_number,
                runtime_seconds, created_at
            ) VALUES (
                ${episode2Id}::uuid, ${'episode'},
                ${'Second Pilot'},
                ${'Episode 2 overview'},
                ${'active'},
                true,
                ${seasonId}::uuid,
                1,
                2,
                3600,
                NOW()
            )
        `;

        return { seriesId, seasonId, episodeId, episode2Id };
    }

    function fakeEvent(opts: {
        url: URL;
        params?: Record<string, string>;
        user?: Record<string, unknown>;
    }) {
        return {
            url: opts.url,
            request: new Request(opts.url, { method: 'GET' }),
            locals: {
                user: opts.user ?? null,
                resolvedIds: undefined,
            },
            params: opts.params ?? {},
            route: { id: null },
            cookies: {} as never,
            fetch,
            getClientAddress: () => '127.0.0.1',
            platform: undefined,
            isDataRequest: false,
            isSubRequest: false,
            setHeaders: () => undefined,
            depends: () => undefined,
            untrack: (fn: () => unknown) => fn(),
        } as unknown as RequestEvent;
    }

    describe('GET /api/browse', () => {
        it('returns recently added items for authenticated user', async () => {
            const user = await insertUser();
            await insertMovie();

            const { GET } = await import('../../api/browse/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/browse?type=movies'),
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(Array.isArray(body.recentlyAdded)).toBe(true);
            expect((body.recentlyAdded as unknown[]).length).toBeGreaterThan(0);
            const first = (body.recentlyAdded as unknown[])[0] as Record<string, unknown>;
            expect(first).toHaveProperty('id');
            // Browse items are MediaPreview: `title`, not `name`.
            expect(first).toHaveProperty('title');
        });

        it('returns 401 when user is not authenticated', async () => {
            const { GET } = await import('../../api/browse/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/browse?type=movies'),
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/v1/search', () => {
        it('returns the { items, page } contract for a query', async () => {
            const user = await insertUser();
            await insertMovie();

            const { GET } = await import('./search/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/v1/search?q=test'),
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                items: Array<Record<string, unknown>>;
                page: Record<string, unknown>;
            };
            // Redesign contract: bare { items, page }, no mediaItems/totalCount.
            expect(Array.isArray(body.items)).toBe(true);
            expect(body).not.toHaveProperty('mediaItems');
            expect(body).not.toHaveProperty('totalCount');
            expect(body.page).toMatchObject({
                limit: expect.any(Number),
                offset: expect.any(Number),
                hasMore: expect.any(Boolean),
            });
            // Each item is a self-describing media handle: canonical type
            // ('series', never 'tv'), ids{}, and images{} — never a flat imageUrl.
            for (const item of body.items) {
                expect(item.type).not.toBe('tv');
                expect(item).not.toHaveProperty('imageUrl');
                expect(item).toHaveProperty('ids');
                expect(item).toHaveProperty('images');
            }
        });

        it('returns 401 when user is not authenticated', async () => {
            const { GET } = await import('./search/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/v1/search?q=test'),
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/media/[id]', () => {
        it('returns media details for existing item', async () => {
            const user = await insertUser();
            const movieId = await insertMovie();

            const { GET } = await import('../../api/media/[id]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/media/${movieId}`),
                    params: { id: movieId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.title).toBe('ES4 Contract Movie');
            expect(body.type).toBe('movie');
            expect(body.ids).toBeDefined();
        });

        it('returns 404 for non-existent item', async () => {
            const user = await insertUser();
            const fakeId = crypto.randomUUID();

            const { GET } = await import('../../api/media/[id]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/media/${fakeId}`),
                    params: { id: fakeId },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(404);
        });

        it('returns 404 for age-restricted user (access scoping)', async () => {
            const user = await insertUser({
                ageRestricted: true,
                maxAgeRating: 8,
            });
            const movieId = await insertMovie({ ageRating: 18 });

            const { GET } = await import('../../api/media/[id]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/media/${movieId}`),
                    params: { id: movieId },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(404);
        });
    });

    describe('GET /api/series/[id]/episodes', () => {
        it('returns episodes for a valid series ID', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/episodes/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/series/${seriesId}/episodes`),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                items: Array<Record<string, unknown>>;
                page: Record<string, unknown>;
            };
            // Redesign contract: bare { items, page }, no success:true or episodes[].
            expect(Array.isArray(body.items)).toBe(true);
            expect(body).not.toHaveProperty('success');
            expect(body).not.toHaveProperty('episodes');
            expect(body.page).toMatchObject({
                limit: expect.any(Number),
                offset: expect.any(Number),
                hasMore: expect.any(Boolean),
            });
            expect(body.items.length).toBeGreaterThan(0);
            const ep = body.items[0];
            expect(ep).toHaveProperty('id');
            // Redesign: field is 'title', not 'name'
            expect(ep).toHaveProperty('title');
            // Episodes are MediaPreview: coordinates live under `context`.
            const epContext = ep.context as Record<string, unknown>;
            expect(epContext).toHaveProperty('seasonNumber');
            expect(epContext).toHaveProperty('episodeNumber');
        });

        it('returns 404 for an unresolvable series ID', async () => {
            const user = await insertUser();

            const { GET } = await import('./series/[id]/episodes/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/series/invalid-id/episodes'),
                    params: { id: 'invalid-id' },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            // The episodes def resolves any id form (UUID, composite key, or a bare
            // dashless Jellyfin id) via resolveCatalogInternalId and returns
            // not_found (404) when the id is unresolvable. It deliberately does NOT
            // do a syntactic format pre-check — that used to 422 valid Jellyfin ids
            // (see the def comment) — mirroring the sibling seasons route.
            expect(res.status).toBe(404);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body).toHaveProperty('code', 'not_found');
            expect(res.headers.get('content-type')).toContain('application/problem+json');
        });
    });

    // ── seasons collection ────────────────────────────────────────────────────

    describe('GET /api/v1/series/[id]/seasons', () => {
        it('returns { items, page } with per-season images{poster} and series.href/episodes.href', async () => {
            const user = await insertUser();
            const { seriesId, seasonId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/seasons`),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                items: Array<Record<string, unknown>>;
                page: Record<string, unknown>;
            };

            // Redesign contract: { items, page } — no legacy success/seasons wrapper
            expect(Array.isArray(body.items)).toBe(true);
            expect(body).not.toHaveProperty('success');
            expect(body).not.toHaveProperty('seasons');
            expect(body).not.toHaveProperty('source');

            // Page block present
            expect(body.page).toMatchObject({
                limit: expect.any(Number),
                offset: 0,
                hasMore: false,
            });

            expect(body.items.length).toBeGreaterThan(0);

            const season = body.items[0];
            // Canonical Season node shape
            expect(season.type).toBe('season');
            expect(typeof season.id).toBe('string');
            expect(typeof season.seasonNumber).toBe('number');
            expect(season).toHaveProperty('ids');

            // images{} with poster role and size presets
            expect(season).toHaveProperty('images');
            const images = season.images as Record<string, Record<string, unknown>>;
            if (images.poster) {
                expect(typeof images.poster.href).toBe('string');
                const variants = images.poster.variants as Record<string, string>;
                expect(typeof variants.thumb).toBe('string');
                expect(typeof variants.card).toBe('string');
                expect(typeof variants.full).toBe('string');
                expect(typeof images.poster.revision).toBe('string');
                expect(typeof images.poster.source).toBe('string');
            }

            // series deep-link
            const seriesLink = season.series as Record<string, unknown>;
            expect(typeof seriesLink.href).toBe('string');
            expect(seriesLink.href).toContain(seriesId);

            // episodes deep-link
            const episodesLink = season.episodes as Record<string, unknown>;
            expect(typeof episodesLink.href).toBe('string');

            // Standard ordering: physical season, `id === catalogId` = season row UUID.
            // `ids` carries external ids only (no `internal` key).
            expect(season.id).toBe(seasonId);
            expect(season.catalogId).toBe(seasonId);
            expect((season.ids as Record<string, string>).internal).toBeUndefined();
        });

        it('returns 401 when user is not authenticated', async () => {
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/seasons`),
                    params: { id: seriesId },
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });

        it('returns 404 for a non-existent series UUID', async () => {
            // resolveCatalogInternalId routes the id through the resolver, which
            // validates the internal PK (a dashed UUID is NOT trusted as-is — it
            // could be a Jellyfin external id). A UUID with no backing row resolves
            // to null, so the def returns 404 "Series not found" before the access
            // gate — the correct REST answer for a missing resource.
            const user = await insertUser();
            const fakeId = crypto.randomUUID();

            const { GET } = await import('./series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${fakeId}/seasons`),
                    params: { id: fakeId },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(404);
        });
    });

    // ── single season by number ───────────────────────────────────────────────

    describe('GET /api/v1/series/[id]/seasons/[n]', () => {
        it('returns a bare Season node for an existing season number', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/seasons/[n]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/seasons/1`),
                    params: { id: seriesId, n: '1' },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;

            // Bare node — NOT { items, page }
            expect(body).not.toHaveProperty('items');
            expect(body).not.toHaveProperty('page');
            expect(body.type).toBe('season');
            expect(body.seasonNumber).toBe(1);
            expect(body).toHaveProperty('images');
        });

        it('returns 404 for a missing season number', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/seasons/[n]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/seasons/99`),
                    params: { id: seriesId, n: '99' },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(404);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.code).toBe('not_found');
            expect(res.headers.get('content-type')).toContain('application/problem+json');
        });

        it('returns 422 for a non-integer n', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/seasons/[n]/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/seasons/abc`),
                    params: { id: seriesId, n: 'abc' },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(422);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.code).toBe('validation_failed');
            expect(res.headers.get('content-type')).toContain('application/problem+json');
        });
    });

    // ── watch-status ──────────────────────────────────────────────────────────

    describe('GET /api/v1/series/[id]/watch-status', () => {
        it('returns { items, page, summary } with images{} on each item', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/watch-status/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/watch-status`),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                items: Array<Record<string, unknown>>;
                page: Record<string, unknown>;
                summary: Record<string, unknown>;
            };

            // Redesign contract: { items, page } + summary
            expect(Array.isArray(body.items)).toBe(true);
            expect(body).not.toHaveProperty('success');
            // page block
            expect(body.page).toMatchObject({
                limit: expect.any(Number),
                offset: 0,
                hasMore: false,
            });
            // summary roll-up counts
            expect(body.summary).toMatchObject({
                total: expect.any(Number),
                watched: expect.any(Number),
                inProgress: expect.any(Number),
                unwatched: expect.any(Number),
            });

            // Each item carries images{} and series.href
            for (const item of body.items) {
                expect(item.type).toBe('episode');
                expect(item).toHaveProperty('images');
                expect(item).toHaveProperty('series');
                expect(item).toHaveProperty('user');
                const images = item.images as Record<string, Record<string, unknown>>;
                expect(images).not.toHaveProperty('still');
                if (images.thumb) {
                    expect(typeof images.thumb.href).toBe('string');
                    expect(typeof images.thumb.source).toBe('string');
                }
            }
        });

        it('returns 401 when user is not authenticated', async () => {
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/watch-status/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/watch-status`),
                    params: { id: seriesId },
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });
    });

    // ── next-episode ──────────────────────────────────────────────────────────

    describe('GET /api/v1/series/[id]/next-episode', () => {
        it('returns a single Episode node or 404 — not a collection', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/next-episode`),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            // Either 200 (episode found) or 404 (no unwatched episode for new user with no history).
            // The route returns a BARE Episode node on 200 — not { items, page }.
            expect([200, 404]).toContain(res.status);

            if (res.status === 200) {
                const body = (await res.json()) as Record<string, unknown>;
                expect(body).not.toHaveProperty('items');
                expect(body).not.toHaveProperty('page');
                expect(body.type).toBe('episode');
                expect(body).toHaveProperty('ids');
                expect(body).toHaveProperty('images');
                const images = body.images as Record<string, Record<string, unknown>>;
                expect(images).not.toHaveProperty('still');
                if (images.thumb) {
                    expect(typeof images.thumb.href).toBe('string');
                    expect(typeof images.thumb.source).toBe('string');
                }
                expect(body).toHaveProperty('series');
            } else {
                const body = (await res.json()) as Record<string, unknown>;
                expect(body.code).toBe('not_found');
                expect(res.headers.get('content-type')).toContain('application/problem+json');
            }
        });

        it('resolves an explicit ?season=1&episode=1 position to the correct episode', async () => {
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(
                        `http://localhost/api/v1/series/${seriesId}/next-episode?season=1&episode=1`,
                    ),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(body.type).toBe('episode');
            expect(body.seasonNumber).toBe(1);
            expect(body.episodeNumber).toBe(1);
            // images{still} present
            const images = body.images as Record<string, Record<string, unknown>>;
            expect(images).not.toHaveProperty('still');
            if (images.thumb) expect(typeof images.thumb.href).toBe('string');
        });

        it('resolves DISTINCT episodes for ?episode=1 vs ?episode=2 (coordinate, not just "an episode")', async () => {
            // A resolver regression that always returned the same (e.g. first)
            // episode would pass an existence-only assertion. Drive both
            // coordinates and prove the returned node differs AND that each
            // returned episodeNumber matches the requested coordinate.
            const user = await insertUser();
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');

            const res1 = await GET(
                fakeEvent({
                    url: new URL(
                        `http://localhost/api/v1/series/${seriesId}/next-episode?season=1&episode=1`,
                    ),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );
            const res2 = await GET(
                fakeEvent({
                    url: new URL(
                        `http://localhost/api/v1/series/${seriesId}/next-episode?season=1&episode=2`,
                    ),
                    params: { id: seriesId },
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res1.status).toBe(200);
            expect(res2.status).toBe(200);
            const e1 = (await res1.json()) as Record<string, unknown>;
            const e2 = (await res2.json()) as Record<string, unknown>;

            // Each coordinate resolves to the matching episode number…
            expect(e1.seasonNumber).toBe(1);
            expect(e1.episodeNumber).toBe(1);
            expect(e2.seasonNumber).toBe(1);
            expect(e2.episodeNumber).toBe(1 + 1);

            // …and the two are genuinely different nodes (distinct ids).
            expect(typeof e1.id).toBe('string');
            expect(typeof e2.id).toBe('string');
            expect(e2.id).not.toBe(e1.id);
            expect(typeof e1.catalogId).toBe('string');
            expect(e2.catalogId).not.toBe(e1.catalogId);
        });

        it('marks an explicit episode without a file as playable: false', async () => {
            const user = await insertUser();
            const { seriesId, episode2Id } = await insertSeriesWithEpisodes();
            await sql`UPDATE media_items SET has_files = false WHERE id = ${episode2Id}::uuid`;

            const { GET } = await import('./series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const fetchEpisode = async (episode: number): Promise<Record<string, unknown>> => {
                const res = await GET(
                    fakeEvent({
                        url: new URL(
                            `http://localhost/api/v1/series/${seriesId}/next-episode?season=1&episode=${episode}`,
                        ),
                        params: { id: seriesId },
                        user,
                    }) as Parameters<typeof GET>[0],
                );
                expect(res.status).toBe(200);
                return (await res.json()) as Record<string, unknown>;
            };

            expect((await fetchEpisode(1)).playable).toBe(true);
            const unaired = await fetchEpisode(2);
            expect(unaired.id).toBe(episode2Id);
            expect(unaired.playable).toBe(false);
        });

        it('returns 401 when user is not authenticated', async () => {
            const { seriesId } = await insertSeriesWithEpisodes();

            const { GET } = await import('./series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL(`http://localhost/api/v1/series/${seriesId}/next-episode`),
                    params: { id: seriesId },
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });
    });

    describe('GET /api/continue-watching', () => {
        it('returns items array for authenticated user', async () => {
            const user = await insertUser();

            const { GET } = await import('./continue-watching/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/continue-watching?limit=10'),
                    user,
                }) as Parameters<typeof GET>[0],
            );

            expect(res.status).toBe(200);
            const body = (await res.json()) as Record<string, unknown>;
            expect(Array.isArray(body.items)).toBe(true);
        });

        it('returns 401 when user is not authenticated', async () => {
            const { GET } = await import('./continue-watching/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                fakeEvent({
                    url: new URL('http://localhost/api/continue-watching'),
                }) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(401);
        });
    });
});
