// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/radio: a removed logo is gone from the list (no logoUrl, so
 * no ✕ button), and a replaced logo gets a new URL (prod 2026-11-24,
 * TechnoBase FM).
 */

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { adminSession } from '$lib/server/api/principal-locals.test-helpers.js';

const database = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => database.sql }));
vi.mock('$lib/server/services/radio-metadata/index.js', () => ({
    peekCacheRecord: vi.fn(async () => null),
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';
import { upsertLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import { deleteMediaImage } from '$lib/server/services/media-image-storage.service.js';

describe('GET /api/admin/radio — station logo', () => {
    let sql: postgres.Sql;
    let stationId: string;

    async function listedLogo(): Promise<string | undefined> {
        const url = new URL('http://localhost/api/admin/radio');
        const event = {
            url,
            request: new Request(url),
            params: {},
            locals: adminSession(),
            route: { id: '/api/admin/radio' },
            cookies: { get: vi.fn(), set: vi.fn() },
            getClientAddress: () => '127.0.0.1',
            setHeaders: vi.fn(),
            fetch: vi.fn(),
        } as unknown as RequestEvent;
        const response = await mount(def, { surface: 'internal' }).GET!(event);
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            stations: { id: string; logoUrl?: string }[];
        };
        return body.stations.find((s) => s.id === stationId)?.logoUrl;
    }

    async function upload(file: string): Promise<void> {
        const filePath = `/config/.metadata/${stationId}/${file}`;
        await upsertLocalArtwork(sql, {
            mediaItemId: stationId,
            artworkType: 'poster',
            filePath,
            sourceTag: 'admin:file',
            provider: 'upload',
            providerRef: filePath,
            localContentHash: file,
        });
    }

    beforeAll(() => {
        sql = getTestDb();
        database.sql = sql;
    });

    beforeEach(async () => {
        stationId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, custom_metadata)
            VALUES (${stationId}, 'Fictional Station FM', 'radio', 'active',
                    ${sql.json({ stream_url: 'http://radio.invalid/stream' })})
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM media_items WHERE media_type = 'radio' AND title = 'Fictional Station FM'`;
        await closeTestDb();
    });

    it('drops the logo after the admin removes it', async () => {
        await upload('poster-a.png');
        expect(await listedLogo()).toBeDefined();

        await deleteMediaImage(sql, stationId, 'poster');

        expect(await listedLogo()).toBeUndefined();
    });

    it('gives a replaced logo a new URL', async () => {
        await upload('poster-a.png');
        const before = await listedLogo();
        await upload('poster-b.png');
        const after = await listedLogo();

        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
    });
});
