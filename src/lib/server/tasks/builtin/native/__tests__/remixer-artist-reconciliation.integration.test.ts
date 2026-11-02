// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import { linkRemixerArtists } from '../media-sources/_helpers/file-scanner/audio-processor.js';
import type { FileScannerContext } from '../media-sources/_helpers/file-scanner/shared.js';

describe('title-derived remixer contribution reconciliation', () => {
    let sql: postgres.Sql;
    let context: FileScannerContext;
    let performerId: string;
    let remixerId: string;
    let albumId: string;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger: mockLogger() } as unknown as FileScannerContext;
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        performerId = randomUUID();
        remixerId = randomUUID();
        albumId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status) VALUES
                (${performerId}::uuid, 'Northern Performer', 'artist', 'active'),
                (${remixerId}::uuid, 'Evening Mixer', 'artist', 'active')
        `;
        await sql`
            INSERT INTO media_items (id, parent_id, title, media_type, status)
            VALUES (${albumId}::uuid, ${performerId}::uuid, 'Night Collection', 'album', 'active')
        `;
    });

    async function addTrack(metadata: Record<string, unknown> = {}): Promise<string> {
        const id = randomUUID();
        await sql`
            INSERT INTO media_items (id, parent_id, title, media_type, status, custom_metadata)
            VALUES (${id}::uuid, ${albumId}::uuid, 'Northern Song (Evening Mixer Remix)', 'track', 'active',
                    ${sql.json(metadata as never)})
        `;
        return id;
    }

    async function read(id: string) {
        const [row] = await sql<{ custom_metadata: Record<string, unknown>; version: string }[]>`
            SELECT custom_metadata, xmin::text AS version FROM media_items WHERE id = ${id}::uuid
        `;
        return row;
    }

    it('removes a suffix-derived relationship after the suffix disappears, with an idempotent rerun', async () => {
        const id = await addTrack();
        await linkRemixerArtists(sql, context);
        const linked = await read(id);
        expect(linked.custom_metadata.title_remixer_artist_ids).toEqual([remixerId]);
        expect(linked.custom_metadata.remixer_artist_ids).toContain(remixerId);
        expect(linked.custom_metadata.additional_artist_ids).toContain(remixerId);

        await sql`UPDATE media_items SET title = 'Northern Song' WHERE id = ${id}::uuid`;
        await linkRemixerArtists(sql, context);
        const removed = await read(id);
        expect(removed.custom_metadata.title_remixer_artist_ids).toEqual([]);
        expect(removed.custom_metadata.remixer_artist_ids).not.toContain(remixerId);
        expect(removed.custom_metadata.additional_artist_ids).not.toContain(remixerId);
        await linkRemixerArtists(sql, context);
        expect(await read(id)).toEqual(removed);
    });

    it.each(['performer', 'album', 'explicit'] as const)(
        'retains independent %s membership when a title-derived credit disappears',
        async (role) => {
            const metadata: Record<string, unknown> = {
                additional_artist_ids: [remixerId],
                operator_note: 'Retain annotation',
            };
            if (role === 'performer') {
                metadata.file_artist_ids = [remixerId];
                metadata.track_artist_credits = [{ id: remixerId, credited_name: 'Evening Mixer' }];
            } else if (role === 'album') {
                metadata.album_artist_ids = [remixerId];
            } else {
                metadata.remixer_artist_ids = [remixerId];
            }
            const id = await addTrack(metadata);
            await linkRemixerArtists(sql, context);
            expect((await read(id)).custom_metadata.title_remixer_artist_ids).toEqual([remixerId]);
            await sql`UPDATE media_items SET title = 'Northern Song (Original Version)' WHERE id = ${id}::uuid`;
            await linkRemixerArtists(sql, context);
            const removed = await read(id);
            expect(removed.custom_metadata.title_remixer_artist_ids).toEqual([]);
            expect(removed.custom_metadata.additional_artist_ids).toContain(remixerId);
            expect(removed.custom_metadata.operator_note).toBe('Retain annotation');
            if (role === 'explicit') {
                expect(removed.custom_metadata.remixer_artist_ids).toContain(remixerId);
            } else {
                expect(removed.custom_metadata.remixer_artist_ids).not.toContain(remixerId);
            }
        },
    );
});
