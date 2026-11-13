// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /j image tags (Jellyfin DtoService) and the image route that serves them,
 * over real PG + Valkey: every tag an item advertises — its own and its
 * parents' — resolves to a real image through /j/Items/{id}/Images, sized by
 * Jellyfin's box parameters.
 */
import { readFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';

// The remote alternate is served from a loopback origin. The image proxy lifts its
// private-range guard only for channel logos behind the Live TV upstream proxy, so
// the public-artwork path refuses that origin. Lift the guard here, for the one test
// that needs it; the refusal itself is covered by image-proxy/service.test.ts.
const loopbackOrigin = vi.hoisted(() => ({ allowPrivate: false }));
vi.mock('$lib/server/utils/ssrf-guard.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/ssrf-guard.js')>();
    return {
        ...actual,
        resolveSafePublicUrl: (url: URL, options?: { allowPrivate?: boolean }) =>
            actual.resolveSafePublicUrl(url, {
                ...options,
                allowPrivate: options?.allowPrivate || loopbackOrigin.allowPrivate,
            }),
    };
});

import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config';
import { getImageProxyService } from '$lib/server/services/image-proxy/index.js';
import {
    getSelectedImageCandidate,
    registerImageCandidate,
} from '$lib/server/database/queries/image-candidates.queries.js';
import { upsertLocalArtwork as registerLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs, seedMusicAlbum } from './seed';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/+server';
import { GET as itemsGet } from '../../src/routes/(proprietary)/j/Items/+server';
import { GET as imageInfosGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Images/+server';
import { GET as imageGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Images/[imageType]/+server';
import { GET as seasonsGet } from '../../src/routes/(proprietary)/j/Shows/[seriesId]/Seasons/+server';
import { GET as imageIndexGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/Images/[imageType]/[imageIndex]/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
const SERIES_BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';
// The image proxy serves local artwork from its managed extraction directory.
const ART_DIR = path.join(config.BASE_PATH || '/tmp', 'image-sync', `contract-${randomUUID()}`);

let sql: postgres.Sql;
let token: string;
let episode: { itemId: string; seriesId: string; seasonId: string };
let movie: { itemId: string };
let music: { albumId: string; trackId: string };

type Dto = {
    Id: string;
    ImageTags?: Record<string, string>;
    BackdropImageTags?: string[];
    ImageBlurHashes?: Record<string, Record<string, string>>;
    SeriesPrimaryImageTag?: string;
    ParentPrimaryImageItemId?: string;
    ParentPrimaryImageTag?: string;
    ParentBackdropItemId?: string;
    ParentBackdropImageTags?: string[];
    ParentLogoItemId?: string;
    ParentLogoImageTag?: string;
    AlbumId?: string;
    AlbumPrimaryImageTag?: string;
    PrimaryImageAspectRatio?: number;
};

/** Register the exact test bytes so positive immutable contracts have a witness. */
async function upsertLocalArtwork(
    db: postgres.Sql,
    params: Parameters<typeof registerLocalArtwork>[1],
): Promise<boolean> {
    const localContentHash = await readFile(params.filePath).then(
        (bytes) => createHash('sha256').update(bytes).digest('hex'),
        () => undefined,
    );
    return registerLocalArtwork(db, { ...params, localContentHash });
}
async function artwork(
    itemId: string,
    type: 'poster' | 'backdrop' | 'logo',
    width: number,
    height: number,
): Promise<void> {
    const file = path.join(ART_DIR, `${itemId}-${type}.png`);
    await sharp({ create: { width, height, channels: 3, background: '#3366aa' } })
        .png()
        .toFile(file);
    await upsertLocalArtwork(sql, { mediaItemId: itemId, artworkType: type, filePath: file });
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
    mkdirSync(ART_DIR, { recursive: true });
});
afterAll(async () => {
    rmSync(ART_DIR, { recursive: true, force: true });
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, ['media_artwork', ...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });

    episode = await seedEpisodeExternalSrt(sql);
    movie = await seedMovieEmbeddedSubs(sql);
    music = await seedMusicAlbum(sql);
    // The series owns poster, backdrop and logo; season, episode and movie own none.
    await artwork(episode.seriesId, 'poster', 600, 900);
    await artwork(episode.seriesId, 'backdrop', 1280, 720);
    await artwork(episode.seriesId, 'logo', 800, 300);
    await sql`UPDATE media_items SET poster_blurhash = ${SERIES_BLURHASH} WHERE id = ${episode.seriesId}`;
    await artwork(music.albumId, 'poster', 500, 500);
});

async function item(name: string, id: string): Promise<Dto> {
    return (await callAndCheck(
        name,
        'BaseItemDto',
        itemGet,
        jfEvent({ method: 'GET', path: `/j/Items/${id}`, token, params: { itemId: id } }),
    )) as Dto;
}

/** Fetch an image the way a client does: no auth, tag + size in the query. */
async function image(
    itemId: string,
    imageType: string,
    query: string,
    imageIndex?: string,
): Promise<Response> {
    const index = imageIndex === undefined ? '' : `/${imageIndex}`;
    const url = new URL(`http://localhost/j/Items/${itemId}/Images/${imageType}${index}${query}`);
    const event = {
        url,
        request: new Request(url),
        params: { itemId, imageType, ...(imageIndex === undefined ? {} : { imageIndex }) },
        locals: {},
    } as unknown as RequestEvent;
    const handler = (imageIndex === undefined ? imageGet : imageIndexGet) as unknown as (
        e: RequestEvent,
    ) => Promise<Response>;
    return handler(event);
}

async function expectRealImage(res: Response, size?: [number, number]): Promise<void> {
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Lumastra-Placeholder')).toBeNull();
    expect(res.headers.get('Content-Type')).toMatch(/^image\//);
    if (size) {
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        expect([meta.width, meta.height]).toEqual(size);
    }
}

describe('/j image tags', () => {
    it('episode without a still: no Primary, series poster / backdrop / logo as parents', async () => {
        const ep = await item('images-episode', episode.itemId);
        expect(ep.ImageTags?.Primary).toBeUndefined();
        expect(ep.BackdropImageTags).toEqual([]);
        expect(ep.SeriesPrimaryImageTag).toMatch(/^[0-9a-f]{32}$/);
        expect(ep.ParentPrimaryImageItemId).toBe(episode.seriesId);
        expect(ep.ParentPrimaryImageTag).toBe(ep.SeriesPrimaryImageTag);
        expect(ep.ParentBackdropItemId).toBe(episode.seriesId);
        expect(ep.ParentBackdropImageTags).toHaveLength(1);
        expect(ep.ParentLogoItemId).toBe(episode.seriesId);
        expect(ep.ImageBlurHashes).toEqual({
            Primary: { [ep.SeriesPrimaryImageTag as string]: SERIES_BLURHASH },
        });
        expect(ep.PrimaryImageAspectRatio).toBeCloseTo(0.667);

        // Every advertised parent tag resolves to the real series image.
        await expectRealImage(
            await image(
                episode.seriesId,
                'Primary',
                `?tag=${ep.SeriesPrimaryImageTag}&fillWidth=200&fillHeight=280&quality=90`,
            ),
            [200, 300],
        );
        const backdrop = await image(
            ep.ParentBackdropItemId as string,
            'Backdrop',
            `?tag=${ep.ParentBackdropImageTags?.[0]}&maxWidth=640`,
            '0',
        );
        await expectRealImage(backdrop, [640, 360]);
        // imageResponse appends its stale-while-revalidate to every image.
        expect(backdrop.headers.get('Cache-Control')).toMatch(
            /^public, max-age=31536000, immutable\b/,
        );
        await expectRealImage(
            await image(ep.ParentLogoItemId as string, 'Logo', `?tag=${ep.ParentLogoImageTag}`),
        );
    });

    it('season without a poster: SeriesPrimaryImageTag, no own Primary', async () => {
        const season = await item('images-season', episode.seasonId);
        expect(season.ImageTags?.Primary).toBeUndefined();
        expect(season.SeriesPrimaryImageTag).toMatch(/^[0-9a-f]{32}$/);
        expect(season.ParentBackdropItemId).toBe(episode.seriesId);
    });

    it("the series' own tags equal the ones its children point at", async () => {
        const series = await item('images-series', episode.seriesId);
        const ep = await item('images-episode-2', episode.itemId);
        expect(series.ImageTags?.Primary).toBe(ep.SeriesPrimaryImageTag);
        expect(series.ImageTags?.Logo).toBe(ep.ParentLogoImageTag);
        expect(series.BackdropImageTags).toEqual(ep.ParentBackdropImageTags);
        expect(series).not.toHaveProperty('ParentBackdropItemId');
        await expectRealImage(
            await image(episode.seriesId, 'Primary', `?tag=${series.ImageTags?.Primary}`),
        );
    });

    it('a movie without artwork advertises no Primary tag', async () => {
        const m = await item('images-movie', movie.itemId);
        expect(m.ImageTags).toEqual({});
        expect(m.BackdropImageTags).toEqual([]);
        expect(m.PrimaryImageAspectRatio).toBeUndefined();
    });

    it('a track points at its album cover', async () => {
        const track = await item('images-track', music.trackId);
        expect(track.AlbumId).toBe(music.albumId);
        expect(track.AlbumPrimaryImageTag).toMatch(/^[0-9a-f]{32}$/);
        await expectRealImage(
            await image(
                music.albumId,
                'Primary',
                `?tag=${track.AlbumPrimaryImageTag}&maxHeight=120&format=jpg`,
            ),
            [120, 120],
        );
    });

    it('list responses (/Items) carry the same tags', async () => {
        const body = (await callAndCheck(
            'images-items-episodes',
            'BaseItemDtoQueryResult',
            itemsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Items?ParentId=${episode.seriesId}&Recursive=true&IncludeItemTypes=Episode`,
                token,
                params: {},
            }),
        )) as { Items: Dto[] };
        const ep = body.Items.find((i) => i.Id === episode.itemId);
        expect(ep?.SeriesPrimaryImageTag).toMatch(/^[0-9a-f]{32}$/);
        expect(ep?.ParentBackdropItemId).toBe(episode.seriesId);
        expect(ep?.ImageTags?.Primary).toBeUndefined();
    });

    it('Shows/{id}/Seasons carries the same tags as Items/{id}', async () => {
        const body = (await callAndCheck(
            'images-seasons',
            'BaseItemDtoQueryResult',
            seasonsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Shows/${episode.seriesId}/Seasons`,
                token,
                params: { seriesId: episode.seriesId },
            }),
        )) as { Items: Dto[] };
        const fromList = body.Items.find((i) => i.Id === episode.seasonId)!;
        const fromItem = await item('images-season-2', episode.seasonId);
        expect(fromList.ImageTags?.Primary).toBeUndefined();
        expect(fromList.SeriesPrimaryImageTag).toBe(fromItem.SeriesPrimaryImageTag);
        expect(fromList.ParentBackdropImageTags).toEqual(fromItem.ParentBackdropImageTags);
    });

    it('a movie with no stored poster but a tmdb id keeps its Primary tag', async () => {
        // The image route fetches such posters live from TMDB by the id.
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${movie.itemId}, 'tmdb', '693134', 'movie', true)`;
        const m = await item('images-movie-tmdb', movie.itemId);
        expect(m.ImageTags?.Primary).toMatch(/^[0-9a-f]{32}$/);
        expect(m.BackdropImageTags).toHaveLength(1);
    });

    it('only the current tag is cached immutable; a stale or serializer tag is not', async () => {
        const series = await item('images-series-cache', episode.seriesId);
        const current = await image(
            episode.seriesId,
            'Primary',
            `?tag=${series.ImageTags?.Primary}&maxWidth=240`,
        );
        expect(current.headers.get('Cache-Control')).toMatch(
            /^public, max-age=31536000, immutable/,
        );
        const serializerTag = episode.seriesId.replace(/-/g, '').slice(0, 16);
        const stale = await image(
            episode.seriesId,
            'Primary',
            `?tag=${serializerTag}&maxWidth=240`,
        );
        await expectRealImage(stale);
        expect(stale.headers.get('Cache-Control')).not.toContain('immutable');

        // An admin re-upload to the same path gives the series a new tag.
        const replacement = path.join(ART_DIR, `${episode.seriesId}-replacement.png`);
        await sharp({ create: { width: 600, height: 900, channels: 3, background: '#cc4422' } })
            .png()
            .toFile(replacement);
        await upsertLocalArtwork(sql, {
            mediaItemId: episode.seriesId,
            artworkType: 'poster',
            filePath: replacement,
            sourceTag: 'admin:upload',
        });
        const after = await item('images-series-reupload', episode.seriesId);
        expect(after.ImageTags?.Primary).not.toBe(series.ImageTags?.Primary);
        const old = await image(episode.seriesId, 'Primary', `?tag=${series.ImageTags?.Primary}`);
        expect(old.headers.get('Cache-Control')).not.toContain('immutable');
        const oldPixels = await sharp(Buffer.from(await current.arrayBuffer()))
            .raw()
            .toBuffer();
        const newPixels = await sharp(Buffer.from(await old.arrayBuffer()))
            .raw()
            .toBuffer();
        expect(newPixels.subarray(0, 3)).not.toEqual(oldPixels.subarray(0, 3));
        const updated = await image(
            episode.seriesId,
            'Primary',
            `?tag=${after.ImageTags?.Primary}`,
        );
        expect(updated.headers.get('Cache-Control')).toContain('immutable');
    });

    it('binds in-flight Jellyfin tagged bytes across a selection change and single-flight overlap', async () => {
        const id = episode.seriesId;
        const before = await item('race-before', id);
        const selected = await getSelectedImageCandidate(sql, id, 'poster');
        const service = getImageProxyService(),
            serve = service.serveImageCandidate.bind(service),
            get = service.getImageByCatalogId.bind(service);
        let started!: () => void, release!: () => void, entered!: () => void;
        const waiting = new Promise<void>((r) => {
                started = r;
            }),
            gate = new Promise<void>((r) => {
                release = r;
            }),
            secondEntered = new Promise<void>((r) => {
                entered = r;
            });
        const spy = vi.spyOn(service, 'serveImageCandidate').mockImplementation(async (...args) => {
            const result = await serve(...args);
            if (args[0].id === selected!.id) {
                started();
                await gate;
            }
            return result;
        });
        let calls = 0;
        const getSpy = vi.spyOn(service, 'getImageByCatalogId').mockImplementation((...args) => {
            const result = get(...args);
            if (++calls === 2) entered();
            return result;
        });
        const older = image(id, 'Primary', `?tag=${before.ImageTags?.Primary}&maxWidth=240`);
        try {
            await waiting;
            const replacement = path.join(ART_DIR, id + '-race.png');
            await sharp({ create: { width: 600, height: 900, channels: 3, background: '#dd4422' } })
                .png()
                .toFile(replacement);
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath: replacement,
                sourceTag: 'admin:upload',
            });
            const after = await item('race-after', id);
            const newer = image(id, 'Primary', `?tag=${after.ImageTags?.Primary}&maxWidth=240`);
            await secondEntered;
            release();
            const [a, b] = await Promise.all([older, newer]);
            const pixels = await sharp(Buffer.from(await b.arrayBuffer()))
                .raw()
                .toBuffer();
            expect(pixels[0]).toBeGreaterThan(180);
            expect(pixels[2]).toBeLessThan(80);
            expect(b.headers.get('Cache-Control')).toContain('immutable');
            expect(a.headers.get('Cache-Control')).not.toContain('immutable');
        } finally {
            release();
            await older;
            spy.mockRestore();
            getSpy.mockRestore();
        }
    });

    it.each(['local', 'remote'] as const)(
        'changes listing tags when selecting an existing %s alternate without rewriting its content',
        async (kind) => {
            const id = kind === 'local' ? episode.seriesId : movie.itemId;
            const blue = await sharp({
                create: { width: 600, height: 900, channels: 3, background: '#3366aa' },
            })
                .png()
                .toBuffer();
            const red = await sharp({
                create: { width: 600, height: 900, channels: 3, background: '#dd4422' },
            })
                .png()
                .toBuffer();
            const origin = createServer((req, res) => {
                res.writeHead(200, { 'content-type': 'image/png' });
                res.end(req.url?.endsWith('/a') ? blue : red);
            });
            let a: string, b: string;
            loopbackOrigin.allowPrivate = true;
            try {
                if (kind === 'local') {
                    a = (await getSelectedImageCandidate(sql, id, 'poster'))!.id;
                    const filePath = path.join(ART_DIR, id + '-existing-red.png');
                    await sharp(red).toFile(filePath);
                    b = (await registerImageCandidate(sql, {
                        mediaItemId: id,
                        role: 'poster',
                        provider: 'local-folder',
                        providerRef: filePath,
                        filePath,
                    }))!;
                    await sql`UPDATE image_candidates SET local_content_hash=${createHash('sha256').update(red).digest('hex')} WHERE id=${b}`;
                } else {
                    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
                    const address = origin.address();
                    if (!address || typeof address === 'string') throw new Error('Missing origin');
                    const base = `http://127.0.0.1:${address.port}`;
                    a = (await registerImageCandidate(sql, {
                        mediaItemId: id,
                        role: 'poster',
                        provider: 'tmdb',
                        providerRef: base + '/a',
                    }))!;
                    b = (await registerImageCandidate(sql, {
                        mediaItemId: id,
                        role: 'poster',
                        provider: 'tmdb',
                        providerRef: base + '/b',
                    }))!;
                }
                const choose = async (candidateId: string) => {
                    await sql`UPDATE image_candidates SET selected=false WHERE media_item_id=${id} AND artwork_type='poster' AND selected`;
                    await sql`UPDATE image_candidates SET selected=true WHERE id=${candidateId}`;
                };
                const timestamps =
                    await sql`SELECT id,updated_at::text FROM image_candidates WHERE media_item_id=${id} ORDER BY id`;
                await choose(a);
                const before = await item('alternate-before-' + kind, id);
                const oldTag = before.ImageTags?.Primary;
                expect(oldTag).toBeTruthy();
                const infosBefore = (await callAndCheck(
                    'alternate-infos-before-' + kind,
                    'List<ImageInfo>',
                    imageInfosGet,
                    jfEvent({
                        method: 'GET',
                        path: `/j/Items/${id}/Images`,
                        token,
                        params: { itemId: id },
                    }),
                )) as { ImageType: string; ImageTag: string }[];
                expect(infosBefore.find((info) => info.ImageType === 'Primary')?.ImageTag).toBe(
                    oldTag,
                );
                const old = await image(id, 'Primary', `?tag=${oldTag}&maxWidth=240`);
                expect(
                    (
                        await sharp(Buffer.from(await old.arrayBuffer()))
                            .raw()
                            .toBuffer()
                    )[2],
                ).toBeGreaterThan(120);
                expect(old.headers.get('Cache-Control')?.includes('immutable')).toBe(
                    kind === 'local',
                );
                await choose(b);
                const after = await item('alternate-after-' + kind, id);
                expect(after.ImageTags?.Primary).toBeTruthy();
                expect(after.ImageTags?.Primary).not.toBe(oldTag);
                const infosAfter = (await callAndCheck(
                    'alternate-infos-after-' + kind,
                    'List<ImageInfo>',
                    imageInfosGet,
                    jfEvent({
                        method: 'GET',
                        path: `/j/Items/${id}/Images`,
                        token,
                        params: { itemId: id },
                    }),
                )) as { ImageType: string; ImageTag: string }[];
                expect(infosAfter.find((info) => info.ImageType === 'Primary')?.ImageTag).toBe(
                    after.ImageTags?.Primary,
                );
                expect(infosAfter.find((info) => info.ImageType === 'Primary')?.ImageTag).not.toBe(
                    oldTag,
                );
                expect(
                    await sql`SELECT id,updated_at::text FROM image_candidates WHERE media_item_id=${id} ORDER BY id`,
                ).toEqual(timestamps);
                const fresh = await image(
                    id,
                    'Primary',
                    `?tag=${after.ImageTags?.Primary}&maxWidth=240`,
                );
                const pixels = await sharp(Buffer.from(await fresh.arrayBuffer()))
                    .raw()
                    .toBuffer();
                expect(pixels[0]).toBeGreaterThan(180);
                expect(pixels[2]).toBeLessThan(80);
                expect(fresh.headers.get('Cache-Control')?.includes('immutable')).toBe(
                    kind === 'local',
                );
                expect(
                    (await image(id, 'Primary', `?tag=${oldTag}&maxWidth=240`)).headers.get(
                        'Cache-Control',
                    ),
                ).not.toContain('immutable');
            } finally {
                loopbackOrigin.allowPrivate = false;
                origin.closeAllConnections();
                if (origin.listening)
                    await new Promise<void>((resolve) => origin.close(() => resolve()));
            }
        },
    );

    it('rotates the first backdrop tag with election order and rejects unsupported indexed variants', async () => {
        const id = episode.seriesId;
        const a = (await getSelectedImageCandidate(sql, id, 'backdrop'))!;
        const filePath = path.join(ART_DIR, id + '-backdrop-second.png');
        await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#dd4422' } })
            .png()
            .toFile(filePath);
        const b = (await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'backdrop',
            provider: 'local-folder',
            providerRef: filePath,
            filePath,
        }))!;
        await sql`UPDATE image_candidates SET local_content_hash=${createHash('sha256')
            .update(await readFile(filePath))
            .digest('hex')} WHERE id=${b}`;
        await sql`UPDATE image_candidates SET selected=true,selection_order=CASE WHEN id=${a.id} THEN 0 ELSE 1 END WHERE media_item_id=${id} AND artwork_type='backdrop'`;
        const dto = await item('backdrop-indexed', id);
        const tag = dto.BackdropImageTags?.[0];
        const first = await image(id, 'Backdrop', `?tag=${tag}&maxWidth=240`, '0');
        const second = await image(id, 'Backdrop', `?tag=${tag}&maxWidth=240`, '1');
        expect((await getSelectedImageCandidate(sql, id, 'backdrop', 1))?.id).toBe(b);
        expect(second.status).toBe(404);
        expect(second.headers.get('Cache-Control') ?? '').not.toContain('immutable');
        expect(first.headers.get('Cache-Control')).toContain('immutable');
        await sql`UPDATE image_candidates SET selection_order=CASE WHEN id=${b} THEN 0 ELSE 1 END WHERE media_item_id=${id} AND artwork_type='backdrop'`;
        const after = await item('backdrop-reordered', id);
        expect(after.BackdropImageTags?.[0]).not.toBe(tag);
        const fresh = await image(
            id,
            'Backdrop',
            `?tag=${after.BackdropImageTags?.[0]}&maxWidth=240`,
            '0',
        );
        const pixels = await sharp(Buffer.from(await fresh.arrayBuffer()))
            .raw()
            .toBuffer();
        expect(pixels[0]).toBeGreaterThan(180);
        expect(fresh.headers.get('Cache-Control')).toContain('immutable');
        expect(
            (await image(id, 'Backdrop', `?tag=${tag}&maxWidth=240`, '0')).headers.get(
                'Cache-Control',
            ),
        ).not.toContain('immutable');
    });

    it('withholds immutable when selection changes A to B to A around the byte fetch', async () => {
        const id = episode.seriesId;
        const original = await getSelectedImageCandidate(sql, id, 'poster');
        const replacement = path.join(ART_DIR, id + '-aba.png');
        await sharp({ create: { width: 600, height: 900, channels: 3, background: '#dd4422' } })
            .png()
            .toFile(replacement);
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: replacement,
            sourceTag: 'admin:upload',
        });
        const alternate = await getSelectedImageCandidate(sql, id, 'poster');
        // Change only the election: restoring A restores the exact advertised
        // source tag while both local files remain available throughout.
        const choose = async (candidateId: string) => {
            await sql`UPDATE image_candidates SET selected = false
                WHERE media_item_id = ${id} AND artwork_type = 'poster' AND selected`;
            await sql`UPDATE image_candidates SET selected = true WHERE id = ${candidateId}`;
        };
        await choose(original!.id);
        const before = await item('aba-before', id);
        const service = getImageProxyService();
        const get = service.getImageByCatalogId.bind(service);
        let servedRevision: string | undefined;
        // This boundary is after the route's initial tag read and before its
        // final tag read; the real service proves B while B is still selected.
        const spy = vi.spyOn(service, 'getImageByCatalogId').mockImplementation(async (...args) => {
            await choose(alternate!.id);
            const result = await get(...args);
            servedRevision = result?.servedRevision;
            await choose(original!.id);
            return result;
        });
        try {
            const response = await image(
                id,
                'Primary',
                `?tag=${before.ImageTags?.Primary}&maxWidth=240`,
            );
            expect(servedRevision).toBeTruthy();
            expect((await item('aba-after', id)).ImageTags?.Primary).toBe(
                before.ImageTags?.Primary,
            );
            const pixels = await sharp(Buffer.from(await response.arrayBuffer()))
                .raw()
                .toBuffer();
            expect(pixels[0]).toBeGreaterThan(180);
            expect(pixels[2]).toBeLessThan(80);
            expect(response.headers.get('Cache-Control')).not.toContain('immutable');
        } finally {
            spy.mockRestore();
        }
    });

    it('bad size parameters are a 400; an unknown index a 404', async () => {
        expect((await image(episode.seriesId, 'Primary', '?fillWidth=wide')).status).toBe(400);
        expect((await image(episode.seriesId, 'Backdrop', '', '3')).status).toBe(404);
    });
});
