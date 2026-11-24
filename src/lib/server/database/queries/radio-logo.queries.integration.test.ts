// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A radio station's logo must disappear when the admin removes it and get a
 * new URL when it is replaced (prod 2026-11-24: TechnoBase FM kept its logo and
 * ✕ button after "Remove", and a replacement kept showing the old picture).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { upsertLocalArtwork } from './media-artwork.queries.js';
import {
    deleteMediaImage,
    deleteMediaImageSlot,
} from '../../services/media-image-storage.service.js';
import { radioLogoRevisionSql } from './radio-logo.queries.js';

describe('radioLogoRevisionSql', () => {
    let sql: postgres.Sql;
    let stationId: string;

    async function revision(): Promise<string | null> {
        const [row] = await sql<{ rev: string | null }[]>`
            SELECT ${radioLogoRevisionSql(sql, 'mi')} AS rev
            FROM media_items mi WHERE mi.id = ${stationId}::uuid
        `;
        return row.rev;
    }

    /** What storeMediaImage registers for an admin file upload. */
    async function upload(file: string): Promise<void> {
        await upsertLocalArtwork(sql, {
            mediaItemId: stationId,
            artworkType: 'poster',
            filePath: `/config/.metadata/${stationId}/${file}`,
            sourceTag: 'admin:file',
            provider: 'upload',
            providerRef: `/config/.metadata/${stationId}/${file}`,
            localContentHash: file,
        });
    }

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_artwork',
            'media_artwork_suppressions',
        ]);
        const station = createTestMediaItem({ media_type: 'radio' as never, title: 'Station' });
        await insertTestMediaItem(sql, station);
        stationId = station.id;
    });

    it('is NULL for a station without a logo', async () => {
        expect(await revision()).toBeNull();
    });

    it('is NULL after the logo is removed, although custom_poster_url stays stamped', async () => {
        await upload('poster-a.png');
        expect(await revision()).not.toBeNull();

        expect(await deleteMediaImage(sql, stationId, 'poster')).toBe(true);

        const [row] = await sql<{ custom_poster_url: string | null }[]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${stationId}::uuid
        `;
        // The stale stamp that used to drive the radio surfaces.
        expect(row.custom_poster_url).toBe(`/api/image/custom/${stationId}/poster`);
        expect(await revision()).toBeNull();
    });

    it('changes when the logo is replaced', async () => {
        await upload('poster-a.png');
        const first = await revision();
        await upload('poster-b.png');
        const second = await revision();

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
    });

    it('is NULL after removing the whole slot, not the previous upload', async () => {
        await upload('poster-a.png');
        await upload('poster-b.png');

        // Hiding only the current image re-selects the earlier upload…
        await deleteMediaImage(sql, stationId, 'poster');
        expect(await revision()).not.toBeNull();

        // …the radio ✕ clears the slot.
        await upload('poster-c.png');
        expect(await deleteMediaImageSlot(sql, stationId, 'poster')).toBe(true);
        expect(await revision()).toBeNull();
        expect(await deleteMediaImageSlot(sql, stationId, 'poster')).toBe(false);
    });

    it('is set again after remove then upload', async () => {
        await upload('poster-a.png');
        await deleteMediaImage(sql, stationId, 'poster');
        await upload('poster-b.png');
        expect(await revision()).not.toBeNull();
    });
});
