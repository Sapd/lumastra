// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import { ImageProxyService } from '../../services/image-proxy/service.js';
import sharp from '../../services/image-proxy/image-sharp.js';
import { upsertLocalArtwork } from '../../database/queries/media-artwork.queries.js';
import { currentImageTag } from './image-enrichment.js';
import { handleItemImage } from './item-image-handler.js';

const state = vi.hoisted(() => ({
    sql: null as postgres.Sql | null,
    service: null as ImageProxyService | null,
}));
vi.mock('$lib/server/database', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/database')>()),
    getDb: () => state.sql,
}));
vi.mock('$lib/server/services/image-proxy', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/image-proxy')>()),
    getImageProxyService: () => state.service,
}));

it('serves canonical /j tags without a chain read and withholds immutable when bytes or selection change', async () => {
    const queries: string[] = [];
    const sql = postgres(getTestDatabaseUrl(), {
        max: 1,
        debug: (_connection, query) => {
            queries.push(query);
        },
    });
    const root = await mkdtemp(path.join(tmpdir(), 'j-image-proof-'));
    const id = crypto.randomUUID();
    const basePath = vi.spyOn(config, 'BASE_PATH', 'get').mockReturnValue(root);
    state.sql = sql;
    const service = new ImageProxyService(sql);
    state.service = service;
    const request = async (tag: string): Promise<Response> => {
        const url = new URL(`http://localhost/j/Items/${id}/Images/Primary?tag=${tag}`);
        return handleItemImage({
            params: { itemId: id, imageType: 'Primary' },
            url,
            request: new Request(url),
            locals: {},
        } as RequestEvent);
    };
    try {
        await mkdir(path.join(root, '.metadata'));
        const filePath = path.join(root, '.metadata', `${id}.png`);
        const bytes = await sharp({
            create: { width: 7, height: 5, channels: 3, background: '#123456' },
        })
            .png()
            .toBuffer();
        await writeFile(filePath, bytes);
        await sql`INSERT INTO media_items (id,title,media_type,status) VALUES (${id},'J image proof','movie','active')`;
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath,
            localContentHash: createHash('sha256').update(bytes).digest('hex'),
        });
        const tag = (await currentImageTag(sql, id, 'Primary'))!;
        expect(tag).toMatch(/^[a-f0-9]{32}$/);
        queries.length = 0;
        const good = await request(tag);
        expect(good.status).toBe(200);
        expect(good.headers.get('Cache-Control')).toContain('immutable');
        expect(Buffer.from(await good.arrayBuffer()).length).toBeGreaterThan(0);
        expect(queries.some((query) => query.includes('WITH RECURSIVE chain(item_id'))).toBe(false);

        const serve = service.serveImageCandidate.bind(service);
        const duringFetch = vi
            .spyOn(service, 'serveImageCandidate')
            .mockImplementationOnce(async (...args) => {
                const response = await serve(...args);
                await sql`UPDATE image_candidates SET local_content_hash=${'b'.repeat(64)} WHERE media_item_id=${id}`;
                return response;
            });
        expect((await request(tag)).headers.get('Cache-Control')).not.toContain('immutable');
        duringFetch.mockRestore();
        const replacement = await sharp({
            create: { width: 7, height: 5, channels: 3, background: '#abcdef' },
        })
            .png()
            .toBuffer();
        await writeFile(filePath, replacement);
        expect((await request(tag)).headers.get('Cache-Control')).not.toContain('immutable');
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath,
            localContentHash: createHash('sha256').update(replacement).digest('hex'),
        });
        const newTag = (await currentImageTag(sql, id, 'Primary'))!;
        expect(newTag).not.toBe(tag);
        expect((await request(tag)).headers.get('Cache-Control')).not.toContain('immutable');
        expect((await request(newTag)).headers.get('Cache-Control')).toContain('immutable');
    } finally {
        basePath.mockRestore();
        await sql`DELETE FROM media_items WHERE id=${id}`;
        await sql.end();
        await rm(root, { recursive: true, force: true });
    }
});
