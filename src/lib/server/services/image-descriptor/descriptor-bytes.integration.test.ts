// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import sharp from '../image-proxy/image-sharp.js';
import { connectionStatus } from '../connection-status.service.js';
import { config } from '$lib/server/config.js';
import { LoggerInstance } from '$lib/server/utils/logger.js';
import { upsertLocalArtwork as registerLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { resolveImageSet } from './resolver.js';
import { deleteEmptyAlbum } from '$lib/server/database/queries/artist-merge.queries.js';
import { resolvePersonImageSet } from './people.js';
import {
    getSelectedImageCandidate,
    registerImageCandidate,
} from '$lib/server/database/queries/image-candidates.queries.js';
import {
    processArtworkDetailed,
    artworkTargetKey,
} from '../../tasks/builtin/native/media-sources/_helpers/file-scanner/ancillary-processors.js';
import type { FileScannerContext } from '../../tasks/builtin/native/media-sources/_helpers/file-scanner/shared.js';
import { writableAlbumArtwork } from '$lib/server/database/queries/music-enrichment-provenance.queries.js';
import { currentImageTag } from '../../proprietary/jellyfin-compat/image-enrichment.js';
import { ImageCache } from '../image-proxy/cache.js';
import { ImageProxyService } from '../image-proxy/service.js';
import { getImageProxyService } from '../image-proxy/index.js';
import { getDb } from '$lib/server/database/index.js';
import { GET as mediaRoute } from '../../../../routes/api/v1/media/[id]/images/[role]/+server.js';
import { GET as personRoute } from '../../../../routes/api/v1/people/[id]/images/[role]/+server.js';
import { mount } from '$lib/server/api/mount.js';
import { def as adminMediaRoute } from '$lib/server/api/defs/admin/media/[id]/images/candidates.js';
import { def as adminPersonRoute } from '$lib/server/api/defs/admin/people/[id]/images/candidates.js';
import { principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import {
    getLiveTvUpstreamDispatcher,
    resetLiveTvUpstreamDispatcher,
} from '../livetv/upstream-proxy.js';

// The HTTP origin of this suite is loopback. Since D-security the image proxy lifts the
// private-range guard only for channel logos behind the Live TV upstream proxy, so the
// public-artwork path would refuse the origin. Lift the guard in this suite only; the
// refusal itself is covered by image-proxy/service.test.ts.
vi.mock('$lib/server/utils/ssrf-guard.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/ssrf-guard.js')>();
    return {
        ...actual,
        resolveSafePublicUrl: (url: URL, options?: { allowPrivate?: boolean }) =>
            actual.resolveSafePublicUrl(url, { ...options, allowPrivate: true }),
    };
});

// Real PostgreSQL, descriptor resolver, route handlers, proxy, HTTP origin and Sharp.
// Only TMDB's external network is replaced for its on-demand API/CDN requests.
let sql: postgres.Sql;
let origin: Server;
let proxy: Server;
let originUrl: string;
let proxyUrl: string;
let png: Buffer;
let originStatus = 200;
let filesRoot: string;
let tunnels = 0;
let forwardedBytes = 0;
const sockets = new Set<Socket>();
const ids: string[] = [];
const people: string[] = [];
const originalFetch = globalThis.fetch;
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
async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
    return `http://127.0.0.1:${address.port}`;
}
async function requestDescriptor(href: string): Promise<Response> {
    const url = new URL(href, 'http://localhost');
    const match = url.pathname.match(/\/(media|people)\/([^/]+)\/images\/([^/]+)$/);
    if (!match) throw new Error(`Unexpected descriptor URL: ${href}`);
    const route = match[1] === 'people' ? personRoute : mediaRoute;
    const locals = principalLocals({
        kind: 'pat',
        ownerIsAdmin: false,
        tokenScopes: ['read'],
        username: 'descriptor-bytes',
    });
    Reflect.deleteProperty(locals, 'user');
    return route!({
        url,
        params: { id: decodeURIComponent(match[2]), role: match[3] },
        locals,
        request: new Request(url),
        getClientAddress: () => '127.0.0.1',
    } as RequestEvent);
}
async function assertBytes(href: string): Promise<void> {
    const response = await requestDescriptor(href);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^image\//);
    const bytes = Buffer.from(await response.arrayBuffer());
    const image = await sharp(bytes).metadata();
    expect(image.width).toBe(7);
    expect(image.height).toBe(5);
    const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    // A decoded pixel proves these are the origin's colored bytes, not a placeholder.
    expect(data[0]).toBeGreaterThan(180);
    expect(data[1]).toBeLessThan(80);
}
async function item(type: string): Promise<string> {
    const id = randomUUID();
    ids.push(id);
    await sql`INSERT INTO media_items (id,title,media_type) VALUES (${id},${'Descriptor byte regression ' + id},${type})`;
    return id;
}
describe('descriptor URLs serve real bytes', () => {
    beforeAll(async () => {
        sql = getTestDb();
        filesRoot = await mkdtemp(path.join(tmpdir(), 'descriptor-bytes-'));
        await mkdir(path.join(filesRoot, '.metadata'));
        vi.spyOn(config, 'BASE_PATH', 'get').mockReturnValue(filesRoot);
        png = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 231, g: 32, b: 61 } },
        })
            .png()
            .toBuffer();
        origin = createServer((_req, res) => {
            res.writeHead(originStatus, { 'content-type': 'image/png' });
            res.end(png);
        });
        originUrl = await listen(origin);
        proxy = createServer((req, res) => {
            // undici supports both absolute-form HTTP forwarding and CONNECT.
            tunnels++;
            forwardedBytes++;
            const target = new URL(req.url ?? '');
            const upstream = httpRequest(
                target,
                { method: req.method, headers: req.headers },
                (answer) => {
                    res.writeHead(answer.statusCode ?? 502, answer.headers);
                    answer.pipe(res);
                },
            );
            upstream.on('error', () => {
                res.writeHead(502);
                res.end();
            });
            req.pipe(upstream);
        });
        proxy.on('connect', (req, client, head) => {
            tunnels++;
            client.on('data', (chunk) => {
                forwardedBytes += chunk.length;
            });
            const destination = new URL(`http://${req.url}`);
            const upstream = createConnection(
                Number(destination.port),
                destination.hostname,
                () => {
                    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    if (head.length) upstream.write(head);
                    client.pipe(upstream);
                    upstream.pipe(client);
                },
            );
            sockets.add(upstream);
            sockets.add(client as Socket);
            upstream.on('error', () => client.destroy());
            client.on('error', () => upstream.destroy());
        });
        proxyUrl = await listen(proxy);
        vi.spyOn(config, 'LIVETV_ALLOW_PRIVATE_URLS', 'get').mockReturnValue(true);
        vi.spyOn(config, 'LIVETV_UPSTREAM_PROXY_URL', 'get').mockReturnValue(proxyUrl);
        vi.spyOn(config, 'IMAGE_PROVIDER_PRIORITY', 'get').mockReturnValue([
            'local',
            'generic',
            'custom',
            'tmdb',
            'jellyfin',
        ]);
        vi.spyOn(config, 'TMDB_API_KEY', 'get').mockReturnValue('test-key');
        vi.spyOn(config, 'JELLYFINURL', 'get').mockReturnValue(originUrl);
        vi.spyOn(config, 'JELLYFINAPIKEY', 'get').mockReturnValue('test-key');
        vi.spyOn(config, 'FEATURE_JELLYFIN_SYNC', 'get').mockReturnValue(true);
        vi.spyOn(config, 'AUDIOURL', 'get').mockReturnValue(originUrl);
        connectionStatus.setConnected('jellyfin');
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                          ? input.href
                          : input.url;
                if (url.startsWith('https://api.themoviedb.org/'))
                    return Response.json({
                        profile_path: '/Testperson.jpg',
                        poster_path: '/Testposter.jpg',
                    });
                if (url.startsWith('https://image.tmdb.org/'))
                    return new Response(new Uint8Array(png), {
                        headers: { 'content-type': 'image/png' },
                    });
                return originalFetch(input, init);
            }),
        );
    });
    afterEach(async () => {
        await sql`DELETE FROM audit_log WHERE target = ANY(${[...ids, ...people]}::text[])`;
        await sql`DELETE FROM image_provider_suppressions WHERE owner = ANY(${[...ids, ...people]}::text[])`;
        await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM image_candidates WHERE person_ref = ANY(${people}::text[])`;
        await sql`DELETE FROM person_image_owners WHERE person_ref = ANY(${people}::text[])`;
        ids.length = 0;
        people.length = 0;
    });
    afterAll(async () => {
        const agent = getLiveTvUpstreamDispatcher();
        if (agent) await agent.close();
        resetLiveTvUpstreamDispatcher();
        for (const socket of sockets) socket.destroy();
        origin.closeAllConnections();
        proxy.closeAllConnections();
        await Promise.all([
            new Promise<void>((resolve) => origin.close(() => resolve())),
            new Promise<void>((resolve) => proxy.close(() => resolve())),
        ]);
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        await rm(filesRoot, { recursive: true, force: true });
        await closeTestDb();
    });
    it.each(['scanner replacement', 'admin upload'] as const)(
        'preserves legacy enrichment ownership on first scanner measurement until %s',
        async (change) => {
            const id = await item('album');
            const filePath = path.join(filesRoot, '.metadata', id + '-enrichment.png');
            const entry = { filePath, artworkType: 'poster' as const };
            const targets = new Map([[artworkTargetKey(entry), { kind: 'target' as const, id }]]);
            const context = { logger: { debug: vi.fn() } } as unknown as FileScannerContext;
            await writeFile(filePath, png);
            // A real legacy registration has provenance but no measured witness yet.
            await registerLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath,
                sourceTag: 'album-enrichment',
                provider: 'musicbrainz-caa',
                providerRef: 'https://coverartarchive.org/release/legacy/front',
            });
            const serveUrl = `/api/image/custom/${id}/poster`;
            const metadata = {
                retained: 'unrelated metadata',
                album_enrichment: {
                    provenance: {
                        poster: { provider: 'musicbrainz-caa', value: serveUrl },
                        biography: { provider: 'discogs', value: 'album biography' },
                    },
                },
                artist_enrichment: {
                    provenance: {
                        poster: { provider: 'theaudiodb', value: serveUrl },
                        biography: { provider: 'discogs', value: 'artist biography' },
                    },
                },
            };
            await sql`UPDATE media_items SET custom_metadata=${sql.json(metadata)} WHERE id=${id}`;
            expect((await writableAlbumArtwork(sql, id)).poster).toBe(true);
            expect(
                (
                    await sql`SELECT local_content_hash FROM image_candidates WHERE media_item_id=${id}`
                )[0].local_content_hash,
            ).toBeNull();
            expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe(
                'updated',
            );
            expect((await writableAlbumArtwork(sql, id)).poster).toBe(true);
            expect(
                (await sql`SELECT custom_metadata FROM media_items WHERE id=${id}`)[0]
                    .custom_metadata,
            ).toEqual(metadata);
            const measured = createHash('sha256').update(png).digest('hex');
            expect(
                (
                    await sql`SELECT local_content_hash,remote_url FROM image_candidates WHERE media_item_id=${id}`
                )[0],
            ).toMatchObject({ local_content_hash: measured, remote_url: 'album-enrichment' });
            const versions = async () => [
                ...(await sql`SELECT xmin::text AS version,'owner' AS kind FROM media_items WHERE id=${id}
                UNION ALL SELECT xmin::text,'candidate' FROM image_candidates WHERE media_item_id=${id}
                UNION ALL SELECT xmin::text,'mirror' FROM media_artwork WHERE media_item_id=${id} ORDER BY kind,version`),
            ];
            const beforeRepeat = await versions();
            expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe(
                'skipped',
            );
            expect(await versions()).toEqual(beforeRepeat);
            if (change === 'scanner replacement') {
                const replacement = await sharp({
                    create: { width: 7, height: 5, channels: 3, background: '#1236dd' },
                })
                    .png()
                    .toBuffer();
                await writeFile(filePath, replacement);
                expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe(
                    'updated',
                );
                expect(
                    (
                        await sql`SELECT local_content_hash FROM image_candidates WHERE media_item_id=${id}`
                    )[0].local_content_hash,
                ).toBe(createHash('sha256').update(replacement).digest('hex'));
            } else {
                await upsertLocalArtwork(sql, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath,
                    sourceTag: 'admin:upload',
                });
            }
            const [after] = await sql<
                { custom_metadata: typeof metadata }[]
            >`SELECT custom_metadata FROM media_items WHERE id=${id}`;
            expect(after.custom_metadata.album_enrichment.provenance).not.toHaveProperty('poster');
            expect(after.custom_metadata.artist_enrichment.provenance).not.toHaveProperty('poster');
            expect(after.custom_metadata.album_enrichment.provenance.biography).toEqual(
                metadata.album_enrichment.provenance.biography,
            );
            expect(after.custom_metadata.artist_enrichment.provenance.biography).toEqual(
                metadata.artist_enrichment.provenance.biography,
            );
            expect(after.custom_metadata.retained).toBe(metadata.retained);
            expect((await writableAlbumArtwork(sql, id)).poster).toBe(false);
        },
    );
    it('scanner measures same-path replacements, rotates native and Jellyfin revisions, and keeps unchanged scans write-free', async () => {
        const id = await item('movie');
        const filePath = path.join(filesRoot, '.metadata', id + '-scanner.png');
        const entry = { filePath, artworkType: 'poster' as const };
        const targets = new Map([[artworkTargetKey(entry), { kind: 'target' as const, id }]]);
        const context = { logger: { debug: vi.fn() } } as unknown as FileScannerContext;
        await writeFile(filePath, png);
        expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe('added');
        const before = (await resolveImageSet(sql, 'v1', id)).poster!;
        const beforeTag = await currentImageTag(sql, id, 'Primary');
        const first = await requestDescriptor(before.href);
        expect(first.headers.get('Cache-Control')).toContain('immutable');
        const firstPixels = await sharp(Buffer.from(await first.arrayBuffer()))
            .raw()
            .toBuffer();
        const [stamp] = await sql<
            { version: string }[]
        >`SELECT xmin::text AS version FROM image_candidates WHERE media_item_id=${id}`;
        expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe(
            'skipped',
        );
        expect(
            (
                await sql<
                    { version: string }[]
                >`SELECT xmin::text AS version FROM image_candidates WHERE media_item_id=${id}`
            )[0],
        ).toEqual(stamp);
        const replacement = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 12, g: 36, b: 225 } },
        })
            .png()
            .toBuffer();
        await writeFile(filePath, replacement);
        // Even before the next scan, changed opened bytes cannot inherit the old proof/cache entry.
        const unobserved = await requestDescriptor(before.href);
        expect(unobserved.headers.get('Cache-Control')).not.toContain('immutable');
        const replacedPixels = await sharp(Buffer.from(await unobserved.arrayBuffer()))
            .raw()
            .toBuffer();
        expect(replacedPixels.subarray(0, 3)).not.toEqual(firstPixels.subarray(0, 3));
        expect((await processArtworkDetailed(sql, entry, context, targets)).outcome).toBe(
            'updated',
        );
        const after = (await resolveImageSet(sql, 'v1', id)).poster!;
        expect(after.revision).not.toBe(before.revision);
        expect(await currentImageTag(sql, id, 'Primary')).not.toBe(beforeTag);
        const fresh = await requestDescriptor(after.href);
        expect(fresh.headers.get('Cache-Control')).toContain('immutable');
        expect(
            await sharp(Buffer.from(await fresh.arrayBuffer()))
                .raw()
                .toBuffer(),
        ).toEqual(replacedPixels);
        // Measurement refreshes do not rewrite a manual choice or lift its lock.
        for (const locked of [false, true]) {
            await sql`UPDATE image_candidates SET chosen_by='admin',locked=${locked} WHERE media_item_id=${id}`;
            await sql`UPDATE image_candidates SET selection_order=7 WHERE media_item_id=${id}`;
            await writeFile(filePath, locked ? replacement : png);
            await processArtworkDetailed(sql, entry, context, targets);
            expect(
                await sql`SELECT chosen_by,locked,selected,selection_order FROM image_candidates WHERE media_item_id=${id}`,
            ).toMatchObject([{ chosen_by: 'admin', locked, selected: true, selection_order: 7 }]);
        }
        const [registered] = await sql<
            { id: string; local_content_hash: string }[]
        >`SELECT id,local_content_hash FROM image_candidates WHERE media_item_id=${id}`;
        await sql`INSERT INTO media_artwork_suppressions(media_item_id,artwork_type,file_path) VALUES(${id},'poster',${filePath})`;
        await writeFile(filePath, png);
        expect((await processArtworkDetailed(sql, entry, context, targets)).ownsRow).toBe(false);
        expect(
            (
                await sql`SELECT id,local_content_hash FROM image_candidates WHERE media_item_id=${id}`
            )[0],
        ).toEqual(registered);
    });
    it('binds in-flight native responses to the bytes served and separates new revision single flight', async () => {
        const id = await item('movie');
        const firstPath = path.join(filesRoot, '.metadata', id + '-first.png');
        const secondPath = path.join(filesRoot, '.metadata', id + '-second.png');
        await writeFile(firstPath, png);
        const blue = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 12, g: 36, b: 225 } },
        })
            .png()
            .toBuffer();
        await writeFile(secondPath, blue);
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: firstPath,
            sourceTag: 'admin:upload',
        });
        const before = (await resolveImageSet(sql, 'v1', id)).poster!;
        const first = await getSelectedImageCandidate(sql, id, 'poster');
        const service = getImageProxyService();
        const serve = service.serveImageCandidate.bind(service);
        let started!: () => void, release!: () => void, entered!: () => void;
        const waiting = new Promise<void>((r) => {
            started = r;
        });
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const secondEntered = new Promise<void>((r) => {
            entered = r;
        });
        const spy = vi.spyOn(service, 'serveImageCandidate').mockImplementation(async (...args) => {
            const answer = await serve(...args);
            if (args[0].id === first!.id) {
                started();
                await gate;
            }
            return answer;
        });
        const get = service.getImageByCatalogId.bind(service);
        let calls = 0;
        const getSpy = vi.spyOn(service, 'getImageByCatalogId').mockImplementation((...args) => {
            const answer = get(...args);
            if (++calls === 2) entered();
            return answer;
        });
        const older = requestDescriptor(before.href);
        try {
            await waiting;
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath: secondPath,
                sourceTag: 'admin:upload',
            });
            const after = (await resolveImageSet(sql, 'v1', id)).poster!;
            const newer = requestDescriptor(after.href);
            await secondEntered;
            release();
            const [a, b] = await Promise.all([older, newer]);
            const pixels = await sharp(Buffer.from(await b.arrayBuffer()))
                .raw()
                .toBuffer();
            expect(pixels[2]).toBeGreaterThan(180);
            expect(b.headers.get('Cache-Control')).toContain('immutable');
            expect(a.headers.get('Cache-Control')).not.toContain('immutable');
        } finally {
            release();
            await older;
            spy.mockRestore();
            getSpy.mockRestore();
        }
    });

    it('uses canonical content version across independent replicas despite a primed same-path stat cache', async () => {
        const id = await item('movie');
        const filePath = path.join(filesRoot, '.metadata', id + '-replicas.png');
        await writeFile(filePath, png);
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath,
            sourceTag: 'admin:upload',
        });
        const reader = new ImageProxyService(sql),
            writer = new ImageProxyService(sql);
        const first = await reader.getImageByCatalogId(id, 'poster', { size: 'card' });
        const before = (await resolveImageSet(sql, 'v1', id)).poster!;
        const blue = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 12, g: 36, b: 225 } },
        })
            .png()
            .toBuffer();
        await writeFile(filePath, blue);
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath,
            sourceTag: 'admin:upload',
        });
        writer.invalidateCatalogImage(id);
        const after = (await resolveImageSet(sql, 'v1', id)).poster!;
        expect(after.revision).not.toBe(before.revision);
        const second = await reader.getImageByCatalogId(id, 'poster', { size: 'card' });
        const oldPixels = await sharp(first!.buffer).raw().toBuffer();
        const newPixels = await sharp(second!.buffer).raw().toBuffer();
        expect(newPixels.subarray(0, 3)).not.toEqual(oldPixels.subarray(0, 3));
        expect(newPixels[2]).toBeGreaterThan(180);
    });

    it('partitions cached HTTP recovery by canonical revision and never proves missing-local fallback bytes', async () => {
        const id = await item('movie');
        const filePath = path.join(filesRoot, '.metadata', id + '-absent.png');
        const ref = originUrl + '/recover-' + id;
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: ref,
            filePath,
        });
        const service = getImageProxyService();
        const before = (await resolveImageSet(sql, 'v1', id)).poster!;
        const first = await requestDescriptor(before.href);
        const oldBytes = Buffer.from(await first.arrayBuffer());
        const saved = png;
        png = await sharp({ create: { width: 7, height: 5, channels: 3, background: '#1236dd' } })
            .png()
            .toBuffer();
        try {
            await sql`UPDATE image_candidates SET fetched_at=fetched_at+interval '1 second',updated_at=updated_at+interval '1 second' WHERE media_item_id=${id}`;
            const after = (await resolveImageSet(sql, 'v1', id)).poster!;
            expect(after.revision).not.toBe(before.revision);
            const fresh = await requestDescriptor(after.href);
            const pixels = await sharp(Buffer.from(await fresh.arrayBuffer()))
                .raw()
                .toBuffer();
            expect(pixels[2]).toBeGreaterThan(180);
            expect(pixels.subarray(0, 3)).not.toEqual(
                (await sharp(oldBytes).raw().toBuffer()).subarray(0, 3),
            );
            expect(fresh.headers.get('Cache-Control')).not.toContain('immutable');
            expect(first.headers.get('Cache-Control')).not.toContain('immutable');
            expect(
                (await requestDescriptor(before.href)).headers.get('Cache-Control'),
            ).not.toContain('immutable');
            expect(
                (await service.getImageByCatalogId(id, 'poster', { revision: after.revision }))
                    ?.servedRevision,
            ).toBeUndefined();
        } finally {
            png = saved;
        }
    });

    it('keeps same-URL remote content mutable when real cached bytes expire and change without a DB revision', async () => {
        const id = await item('movie');
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'upload',
            providerRef: originUrl + '/mutable-' + id,
        });
        const service = getImageProxyService();
        const oldCache = Reflect.get(service, 'customUrlCache');
        const dir = path.join(filesRoot, 'mutable-' + id);
        Reflect.set(service, 'customUrlCache', new ImageCache({ directory: dir, ttl: 1000 }));
        const saved = png;
        try {
            const descriptor = (await resolveImageSet(sql, 'v1', id)).poster!;
            const first = await requestDescriptor(descriptor.href);
            const beforePixels = await sharp(Buffer.from(await first.arrayBuffer()))
                .raw()
                .toBuffer();
            await expect
                .poll(
                    async () =>
                        (await readdir(dir).catch(() => [])).filter((f) => !f.endsWith('.tmp'))
                            .length,
                )
                .toBe(1);
            for (const file of await readdir(dir))
                await utimes(path.join(dir, file), new Date(0), new Date(0));
            png = await sharp({
                create: { width: 7, height: 5, channels: 3, background: '#1236dd' },
            })
                .png()
                .toBuffer();
            const fresh = await requestDescriptor(descriptor.href);
            const afterPixels = await sharp(Buffer.from(await fresh.arrayBuffer()))
                .raw()
                .toBuffer();
            expect(afterPixels[2]).toBeGreaterThan(180);
            expect(afterPixels.subarray(0, 3)).not.toEqual(beforePixels.subarray(0, 3));
            expect((await resolveImageSet(sql, 'v1', id)).poster!.revision).toBe(
                descriptor.revision,
            );
            expect(first.headers.get('Cache-Control')).not.toContain('immutable');
            expect(fresh.headers.get('Cache-Control')).not.toContain('immutable');
            expect(
                (await service.getImageByCatalogId(id, 'poster', { revision: descriptor.revision }))
                    ?.servedRevision,
            ).toBeUndefined();
        } finally {
            png = saved;
            Reflect.set(service, 'customUrlCache', oldCache);
        }
    });
    it('withholds immutable for an expired remote-candidate cache entry served after an upstream failure', async () => {
        const id = await item('movie');
        await registerImageCandidate(sql, {
            mediaItemId: id,
            role: 'poster',
            provider: 'tmdb',
            providerRef: originUrl + '/stale-' + id,
        });
        const service = getImageProxyService();
        const oldCache = Reflect.get(service, 'customUrlCache');
        const dir = path.join(filesRoot, 'stale-' + id);
        Reflect.set(
            service,
            'customUrlCache',
            new ImageCache({ directory: dir, ttl: 1000, staleIfError: true }),
        );
        try {
            const descriptor = (await resolveImageSet(sql, 'v1', id)).poster!;
            const first = await requestDescriptor(descriptor.href);
            const firstBytes = Buffer.from(await first.arrayBuffer());
            expect(first.headers.get('Cache-Control')).not.toContain('immutable');
            await expect
                .poll(
                    async () =>
                        (await readdir(dir).catch(() => [])).filter((f) => !f.endsWith('.tmp'))
                            .length,
                )
                .toBe(1);
            for (const file of await readdir(dir))
                await utimes(path.join(dir, file), new Date(0), new Date(0));
            originStatus = 503;
            const stale = await requestDescriptor(descriptor.href);
            expect(Buffer.from(await stale.arrayBuffer())).toEqual(firstBytes);
            expect(stale.headers.get('Cache-Control')).not.toContain('immutable');
            expect(stale.headers.get('Cache-Control')).toContain('max-age=600');
        } finally {
            originStatus = 200;
            Reflect.set(service, 'customUrlCache', oldCache);
        }
    });

    it.each([777, null])(
        'refreshes locked historical ABS bytes when coverPath changes with unchanged updatedAt=%s',
        async (updatedAt) => {
            const id = await item('audiobook');
            await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type) VALUES(${id},'audiobookshelf',${id},'audiobook')`;
            const metadata = (coverPath: string) => ({
                audiobookshelf: { coverPath, ...(updatedAt == null ? {} : { updatedAt }) },
            });
            await sql`UPDATE media_items SET custom_metadata=${sql.json(metadata('/historical.jpg'))} WHERE id=${id}`;
            const elected = await getSelectedImageCandidate(sql, id, 'poster');
            await sql`UPDATE image_candidates SET locked=true,chosen_by='admin' WHERE id=${elected!.id}`;
            await sql`UPDATE media_items SET custom_metadata=${sql.json(metadata('/current-a.jpg'))} WHERE id=${id}`;
            const before = (await resolveImageSet(sql, 'v1', id)).primary!;
            const first = await requestDescriptor(before.href);
            const oldPixels = await sharp(Buffer.from(await first.arrayBuffer()))
                .raw()
                .toBuffer();
            const saved = png;
            png = await sharp({
                create: { width: 7, height: 5, channels: 3, background: '#1236dd' },
            })
                .png()
                .toBuffer();
            try {
                await sql`UPDATE media_items SET custom_metadata=${sql.json(metadata('/current-b.jpg'))} WHERE id=${id}`;
                const after = (await resolveImageSet(sql, 'v1', id)).primary!;
                expect(after.revision).not.toBe(before.revision);
                const fresh = await requestDescriptor(after.href);
                const pixels = await sharp(Buffer.from(await fresh.arrayBuffer()))
                    .raw()
                    .toBuffer();
                expect(pixels[2]).toBeGreaterThan(180);
                expect(pixels.subarray(0, 3)).not.toEqual(oldPixels.subarray(0, 3));
                expect(await getSelectedImageCandidate(sql, id, 'poster')).toMatchObject({
                    id: elected!.id,
                    provider_ref: '/historical.jpg',
                    locked: true,
                });
                if (updatedAt !== null)
                    expect(fresh.headers.get('Cache-Control')).toContain('immutable');
                else expect(fresh.headers.get('Cache-Control')).not.toContain('immutable');
                expect(
                    (await requestDescriptor(before.href)).headers.get('Cache-Control'),
                ).not.toContain('immutable');
            } finally {
                png = saved;
            }
        },
    );

    it('refreshes the current fetched ABS cover when a locked historical reference remains chosen', async () => {
        const id = await item('audiobook');
        await sql`INSERT INTO external_ids(media_id,provider,external_id,media_type) VALUES(${id},'audiobookshelf',${id},'audiobook')`;
        await sql`UPDATE media_items SET custom_metadata=${sql.json({ audiobookshelf: { coverPath: '/historical.jpg', updatedAt: 700 } })} WHERE id=${id}`;
        const candidate = await getSelectedImageCandidate(sql, id, 'poster');
        await sql`UPDATE image_candidates SET chosen_by='admin',locked=true WHERE id=${candidate!.id}`;
        await sql`UPDATE media_items SET custom_metadata=${sql.json({ audiobookshelf: { coverPath: '/current.jpg', updatedAt: 701 } })} WHERE id=${id}`;
        const before = (await resolveImageSet(sql, 'v1', id)).primary!;
        const firstBytes = Buffer.from(await (await requestDescriptor(before.href)).arrayBuffer());
        const original = png;
        png = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 12, g: 36, b: 225 } },
        })
            .png()
            .toBuffer();
        await sql`UPDATE media_items SET custom_metadata=${sql.json({ audiobookshelf: { coverPath: '/current.jpg', updatedAt: 702 } })} WHERE id=${id}`;
        const after = (await resolveImageSet(sql, 'v1', id)).primary!;
        expect(after.revision).not.toBe(before.revision);
        expect(await getSelectedImageCandidate(sql, id, 'poster')).toMatchObject({
            id: candidate!.id,
            provider_ref: '/historical.jpg',
            locked: true,
        });
        try {
            const secondBytes = Buffer.from(
                await (await requestDescriptor(after.href)).arrayBuffer(),
            );
            expect((await sharp(secondBytes).raw().toBuffer()).subarray(0, 3)).not.toEqual(
                (await sharp(firstBytes).raw().toBuffer()).subarray(0, 3),
            );
        } finally {
            png = original;
        }
    });

    it('serves a normalized uppercase HTTP legacy reference', async () => {
        const id = await item('movie');
        const url = `${originUrl}/${id}.png`.replace('http:', 'HTTP:');
        await sql`INSERT INTO media_artwork(media_item_id,artwork_type,source,file_path) VALUES(${id},'poster','tmdb',${url})`;
        const descriptor = (await resolveImageSet(sql, 'v1', id)).poster!;
        await assertBytes(descriptor.href);
    });

    const mediaCases = [
        ['movie', 'poster', 'poster'],
        ['episode', 'thumb', 'thumb'],
        ['album', 'primary', 'poster'],
        ['artist', 'primary', 'poster'],
        ['track', 'primary', 'poster'],
        ['audiobook', 'primary', 'poster'],
        ['tvchannel', 'primary', 'poster'],
    ] as const;
    for (const state of [
        'selected',
        'no candidate',
        'no selection',
        'missing selected file',
    ] as const) {
        it.each(mediaCases)(`%s %s via descriptor with ${state}`, async (type, role, slot) => {
            const id = await item(type);
            const url = `${originUrl}/${id}.png`;
            const column = slot === 'thumb' ? 'custom_thumb_url' : 'custom_poster_url';
            await sql`UPDATE media_items SET ${sql(column)} = ${url} WHERE id=${id}`;
            let descriptor = (await resolveImageSet(sql, 'v1', id))[role];
            expect(descriptor?.href).toBeTruthy();
            const selected = await getSelectedImageCandidate(sql, id, slot);
            expect(selected).not.toBeNull();
            if (state === 'no candidate') {
                await sql`DELETE FROM image_candidates WHERE media_item_id=${id}`;
                descriptor = (await resolveImageSet(sql, 'v1', id))[role];
                expect(descriptor?.href).toBeTruthy();
            }
            if (state === 'no selection')
                await sql`UPDATE image_candidates SET selected=false WHERE media_item_id=${id}`;
            if (state === 'missing selected file')
                await sql`UPDATE image_candidates SET file_path=${path.join(filesRoot, '.metadata', id + '-missing.png')},chosen_by='admin',locked=true WHERE id=${selected!.id}`;
            if (state === 'selected')
                await sql`UPDATE media_items SET ${sql(column)}=NULL WHERE id=${id}`;
            const before = forwardedBytes;
            await assertBytes(descriptor!.href);
            if (type === 'tvchannel') {
                expect(tunnels).toBeGreaterThan(0);
                expect(forwardedBytes).toBeGreaterThan(before);
            }
            // Both byte-role spellings resolve the same candidate for movies and covers.
            if (state === 'selected')
                await assertBytes(
                    descriptor!.href.replace(
                        `/images/${slot}`,
                        `/images/${slot === 'poster' ? 'primary' : slot}`,
                    ),
                );
            if (state === 'missing selected file')
                expect(await getSelectedImageCandidate(sql, id, slot)).toMatchObject({
                    id: selected!.id,
                    locked: true,
                    provider_ref: url,
                });
        });
    }
    it('refreshes ABS bytes and cache revisions at the same cover path while a locked upload stays stable', async () => {
        const id = await item('audiobook');
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type)
            VALUES (${id},'audiobookshelf',${id},'audiobook')`;
        await sql`UPDATE media_items SET custom_metadata = ${sql.json({ audiobookshelf: { coverPath: '/same-cover.jpg', updatedAt: 100 } })} WHERE id = ${id}`;
        const before = (await resolveImageSet(sql, 'v1', id)).primary!;
        const first = await requestDescriptor(before.href);
        expect(first.status).toBe(200);
        expect(first.headers.get('Cache-Control')).toContain('immutable');
        const firstPixels = await sharp(Buffer.from(await first.arrayBuffer()))
            .raw()
            .toBuffer();
        const original = png;
        png = await sharp({
            create: { width: 7, height: 5, channels: 3, background: { r: 18, g: 210, b: 81 } },
        })
            .png()
            .toBuffer();
        try {
            await sql`UPDATE media_items SET custom_metadata = jsonb_set(custom_metadata,'{audiobookshelf,updatedAt}','101') WHERE id = ${id}`;
            const after = (await resolveImageSet(sql, 'v1', id)).primary!;
            expect(after.revision).not.toBe(before.revision);
            const fresh = await requestDescriptor(after.href);
            expect(fresh.status).toBe(200);
            expect(fresh.headers.get('Cache-Control')).toContain('immutable');
            const freshBytes = Buffer.from(await fresh.arrayBuffer());
            const newPixels = await sharp(freshBytes).raw().toBuffer();
            expect(newPixels.subarray(0, 3)).not.toEqual(firstPixels.subarray(0, 3));
            const replay = await requestDescriptor(after.href);
            expect(Buffer.from(await replay.arrayBuffer())).toEqual(freshBytes);
            const stale = await requestDescriptor(before.href);
            expect(stale.headers.get('Cache-Control')).not.toContain('immutable');
            const uploadPath = path.join(filesRoot, '.metadata', `${id}-locked.png`);
            await writeFile(uploadPath, original);
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath: uploadPath,
                sourceTag: 'admin:upload',
            });
            const locked = (await resolveImageSet(sql, 'v1', id)).primary!;
            await sql`UPDATE media_items SET custom_metadata = jsonb_set(custom_metadata,'{audiobookshelf,updatedAt}','102') WHERE id = ${id}`;
            expect((await resolveImageSet(sql, 'v1', id)).primary?.revision).toBe(locked.revision);
            await assertBytes(locked.href);
        } finally {
            png = original;
        }
    });

    it('retains the canonical uploaded candidate and served bytes across an empty-album merge', async () => {
        const sourceArtist = await item('artist');
        const targetArtist = await item('artist');
        const source = await item('album');
        const target = await item('album');
        await sql`UPDATE media_items SET parent_id = ${sourceArtist} WHERE id = ${source}`;
        await sql`UPDATE media_items SET parent_id = ${targetArtist} WHERE id = ${target}`;
        const uploadPath = path.join(filesRoot, '.metadata', `${source}-upload.png`);
        await writeFile(uploadPath, png);
        await upsertLocalArtwork(sql, {
            mediaItemId: source,
            artworkType: 'poster',
            filePath: uploadPath,
            sourceTag: 'admin:upload',
        });
        const candidate = await getSelectedImageCandidate(sql, source, 'poster');
        await assertBytes((await resolveImageSet(sql, 'v1', source)).primary!.href);
        expect(await deleteEmptyAlbum(sql, source, target)).toBe(true);
        expect(await getSelectedImageCandidate(sql, target, 'poster')).toMatchObject({
            id: candidate!.id,
            provider: 'upload',
            provider_ref: uploadPath,
            file_path: uploadPath,
            locked: true,
        });
        expect(await getSelectedImageCandidate(sql, source, 'poster')).toBeNull();
        expect(
            await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${target}`,
        ).toEqual([{ file_path: uploadPath }]);
        await assertBytes((await resolveImageSet(sql, 'v1', target)).primary!.href);
    });

    it('serves a legacy HTTP file reference remotely and retains its canonical identity on replay', async () => {
        const id = await item('movie');
        const url = `${originUrl}/${id}.png`;
        await sql`INSERT INTO media_artwork (media_item_id,artwork_type,source,file_path)
            VALUES (${id},'poster','tmdb',${url})`;
        const selected = await getSelectedImageCandidate(sql, id, 'poster');
        expect(selected).toMatchObject({
            provider: 'tmdb',
            provider_ref: url,
            file_path: null,
            remote_url: url,
        });
        const descriptor = (await resolveImageSet(sql, 'v1', id)).poster!;
        await assertBytes(descriptor.href);
        await sql`SELECT backfill_legacy_artwork(id) FROM media_artwork WHERE media_item_id = ${id}`;
        expect((await getSelectedImageCandidate(sql, id, 'poster'))?.id).toBe(selected?.id);
        expect((await resolveImageSet(sql, 'v1', id)).poster?.revision).toBe(descriptor.revision);
    });

    it.each(['admin:url', 'album-enrichment'] as const)(
        'recovers a missing selected file from HTTP identity with the %s writer marker',
        async (sourceTag) => {
            const id = await item('album');
            const url = `${originUrl}/${id}.png`;
            await upsertLocalArtwork(sql, {
                mediaItemId: id,
                artworkType: 'poster',
                filePath: path.join(filesRoot, '.metadata', `${id}-missing.png`),
                sourceTag,
                provider: 'discogs',
                providerRef: url,
            });
            const selected = await getSelectedImageCandidate(sql, id, 'poster');
            expect(selected).toMatchObject({ provider_ref: url, remote_url: sourceTag });
            const descriptor = (await resolveImageSet(sql, 'v1', id)).primary;
            await assertBytes(descriptor!.href);
            expect(await getSelectedImageCandidate(sql, id, 'poster')).toMatchObject({
                id: selected!.id,
                provider_ref: url,
                remote_url: sourceTag,
                locked: sourceTag === 'admin:url',
            });
        },
    );
    it.each([true, false])(
        'does not replace an unservable selection with legacy artwork (locked=%s)',
        async (locked) => {
            const id = await item('movie');
            // The legacy chain can fetch this Jellyfin identity, but it is not the selection.
            const jellyfin = randomUUID().replaceAll('-', '');
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${id},'jellyfin',${jellyfin},'movie')`;
            const candidate = await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'upload',
                providerRef: `${id}-unrecoverable`,
                filePath: path.join(filesRoot, '.metadata', `${id}-missing.png`),
            });
            if (locked)
                await sql`UPDATE image_candidates SET chosen_by='admin',locked=true WHERE id=${candidate}`;
            const descriptor = (await resolveImageSet(sql, 'v1', id)).poster;
            const warn = vi.spyOn(LoggerInstance.prototype, 'warn');
            try {
                const response = await requestDescriptor(descriptor!.href);
                // Normal browser placeholder (native clients receive the normal 404).
                expect(response.status).toBe(200);
                const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
                expect(metadata.width).not.toBe(7);
                expect(response.headers.get('X-Lumastra-Placeholder')).toBe('1');
                if (locked)
                    expect(warn).toHaveBeenCalledWith(
                        'Locked image selection could not be served',
                        expect.objectContaining({ candidateId: candidate, uuid: id }),
                    );
                expect(await getSelectedImageCandidate(sql, id, 'poster')).toMatchObject({
                    id: candidate,
                    locked,
                });
            } finally {
                warn.mockRestore();
            }
            // Removing the selection enables the same legacy provider again.
            await sql`DELETE FROM image_candidates WHERE media_item_id=${id}`;
            getImageProxyService(getDb()!).invalidateCatalogImage(id);
            await assertBytes(`/api/v1/media/${id}/images/poster`);
        },
    );
    it('keeps an unservable locked person selection authoritative over TMDB discovery', async () => {
        const handle = 'tmdb:99887765';
        people.push(handle);
        const [candidate] = await sql<
            { id: string }[]
        >`SELECT register_person_image_candidate(${handle},'upload','unrecoverable-upload') AS id`;
        await sql`UPDATE image_candidates SET chosen_by='admin',locked=true WHERE id=${candidate.id}`;
        const descriptor = (await resolvePersonImageSet(sql, 'v1', handle)).primary;
        const warn = vi.spyOn(LoggerInstance.prototype, 'warn');
        try {
            expect((await requestDescriptor(descriptor!.href)).status).toBe(404);
            expect(warn).toHaveBeenCalledWith(
                'Locked image selection could not be served',
                expect.objectContaining({ personRef: handle, candidateId: candidate.id }),
            );
            expect(await getSelectedImageCandidate(sql, handle, 'poster')).toMatchObject({
                id: candidate.id,
                locked: true,
                provider_ref: 'unrecoverable-upload',
            });
        } finally {
            warn.mockRestore();
        }
        await sql`DELETE FROM image_candidates WHERE person_ref=${handle}`;
        await assertBytes(descriptor!.href);
    });
    it.each(['selected', 'no candidate', 'missing selected file'] as const)(
        'person descriptor with %s',
        async (state) => {
            const numeric = String(Math.floor(Math.random() * 100000000) + 1000000);
            const handle = `tmdb:${numeric}`;
            people.push(handle);
            const images = await resolvePersonImageSet(
                sql,
                'v1',
                handle,
                `${originUrl}/${numeric}.png`,
            );
            const selected = await getSelectedImageCandidate(sql, handle, 'poster');
            if (state === 'no candidate')
                await sql`DELETE FROM image_candidates WHERE person_ref=${handle}`;
            if (state === 'missing selected file')
                await sql`UPDATE image_candidates SET file_path=${path.join(filesRoot, '.metadata', numeric + '-missing.png')} WHERE id=${selected!.id}`;
            await assertBytes(images.primary!.href);
        },
    );
    it.each(['pat', 'service_token'] as const)(
        '%s principal without locals.user can curate media and people',
        async (kind) => {
            const id = await item('movie');
            const person = 'tmdb:99887766';
            people.push(person);
            await registerImageCandidate(sql, {
                mediaItemId: id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/A.jpg',
            });
            await resolvePersonImageSet(sql, 'v1', person, '/A.jpg');
            const locals = principalLocals({
                kind,
                ownerIsAdmin: true,
                tokenScopes: ['admin'],
                username: 'token-admin',
            });
            Reflect.deleteProperty(locals, 'user');
            expect(locals.principal?.isAdmin).toBe(true);
            for (const [route, owner] of [
                [adminMediaRoute, id],
                [adminPersonRoute, person],
            ] as const) {
                const url = new URL(`http://localhost/admin/images/${owner}`);
                const selected = await getSelectedImageCandidate(sql, owner, 'poster');
                const event = {
                    url,
                    params: { id: owner },
                    locals,
                    getClientAddress: () => '127.0.0.1',
                    request: new Request(url, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            action: 'select',
                            candidateId: selected!.id,
                            locked: true,
                        }),
                    }),
                } as RequestEvent;
                const response = await mount(route, { surface: 'internal' }).POST!(event);
                expect(response.status).toBe(200);
                expect((await getSelectedImageCandidate(sql, owner, 'poster'))?.locked).toBe(true);
                const [audit] =
                    await sql`SELECT actor,principal_kind FROM audit_log WHERE target=${owner} ORDER BY id DESC LIMIT 1`;
                expect(audit).toMatchObject({ actor: 'token-admin', principal_kind: kind });
            }
        },
    );
    it('TMDB on-demand discovery still serves a movie without captured references', async () => {
        const id = await item('movie');
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${id},'tmdb','998877','movie')`;
        const response = await requestDescriptor(`/api/v1/media/${id}/images/poster`);
        expect(response.status).toBe(200);
        expect((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width).toBe(7);
    });
    it.each(['backdrop', 'logo', 'thumb'] as const)(
        'discovers uncaptured Jellyfin %s through the legacy chain',
        async (role) => {
            const id = await item('movie');
            const jellyfin = randomUUID().replaceAll('-', '');
            await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${id},'jellyfin',${jellyfin},'movie')`;
            await sql`INSERT INTO provider_metadata (media_id,provider,metadata) VALUES (${id},'jellyfin',${sql.json({ ImageTags: { Primary: 'tag' } })})`;
            expect(await getSelectedImageCandidate(sql, id, role)).toBeNull();
            await assertBytes(`/api/v1/media/${id}/images/${role}`);
        },
    );
    it('serves Audiobookshelf cover descriptors before capture and with a missing selected cache file', async () => {
        const id = await item('audiobook');
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${id},'audiobookshelf',${id},'audiobook')`;
        await sql`UPDATE media_items SET custom_metadata=${sql.json({ audiobookshelf: { libraryItemId: id, coverPath: '/cover.jpg', updatedAt: 1234 } })} WHERE id=${id}`;
        const descriptor = (await resolveImageSet(sql, 'v1', id)).primary;
        expect(descriptor).toBeDefined();
        const selected = await getSelectedImageCandidate(sql, id, 'poster');
        await sql`UPDATE image_candidates SET file_path=${path.join(filesRoot, '.metadata', id + '-missing.jpg')} WHERE id=${selected!.id}`;
        const missing = (await resolveImageSet(sql, 'v1', id)).primary!;
        expect(missing.revision).not.toBe(descriptor!.revision);
        const service = getImageProxyService(getDb()!);
        const recovered = await service.getImageByCatalogId(id, 'poster', {
            size: 'full',
            revision: missing.revision,
        });
        expect(recovered?.servedRevision).toBeUndefined();
        const pixels = await sharp(recovered!.buffer).raw().toBuffer();
        expect(pixels[0]).toBeGreaterThan(180);
        expect(pixels[1]).toBeLessThan(80);
        const response = await requestDescriptor(missing.href);
        expect(response.headers.get('Cache-Control')).not.toContain('immutable');
        await assertBytes(missing.href);
        await sql`DELETE FROM image_candidates WHERE media_item_id=${id}`;
        getImageProxyService(getDb()!).invalidateCatalogImage(id);
        await assertBytes(descriptor!.href);
    });
    it('serves a historical local file before its background capture batch', async () => {
        const id = await item('album');
        const file = path.join(filesRoot, '.metadata', `${id}.png`);
        await writeFile(file, png);
        await sql.begin(async (tx) => {
            await tx`ALTER TABLE media_artwork DISABLE TRIGGER image_legacy_capture`;
            await tx`INSERT INTO media_artwork (media_item_id,artwork_type,source,file_path) VALUES (${id},'poster','local',${file})`;
            await tx`ALTER TABLE media_artwork ENABLE TRIGGER image_legacy_capture`;
        });
        expect(await getSelectedImageCandidate(sql, id, 'poster')).toBeNull();
        const descriptor = (await resolveImageSet(sql, 'v1', id)).primary;
        expect(
            (await requestDescriptor(descriptor!.href)).headers.get('Cache-Control'),
        ).not.toContain('immutable');
        await assertBytes(descriptor!.href);
    });
    it('track descriptor inherited from an album serves that album cover', async () => {
        const album = await item('album');
        const track = await item('track');
        await sql`UPDATE media_items SET parent_id=${album} WHERE id=${track}`;
        await sql`UPDATE media_items SET custom_poster_url=${`${originUrl}/${album}.png`} WHERE id=${album}`;
        const descriptor = (await resolveImageSet(sql, 'v1', track)).primary;
        expect(descriptor?.source).toBe('album');
        await assertBytes(descriptor!.href);
    });
    it('deliberate provider deletion cannot be bypassed by on-demand fallback', async () => {
        const id = await item('movie');
        await sql`INSERT INTO image_provider_suppressions VALUES (${id},'tmdb','poster')`;
        await sql`INSERT INTO external_ids (media_id,provider,external_id,media_type) VALUES (${id},'tmdb','887766','movie')`;
        expect(await getImageProxyService(getDb()!).getImageByCatalogId(id, 'poster')).toBeNull();
    });
});
