// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { enrichItemsWithMediaSources } from './media-source-enrichment';
import type { JellyfinBaseItemDto } from './types';

/**
 * Verifies the Task 1 audit ruling that all `getJfToken` read-route consumers
 * are safe under PAT auth (where `jfToken === ''`). With an empty apiKey, the
 * URL builder must produce well-formed (single trailing `&api_key=`) URLs and
 * must not crash. Any consumer that did try to fetch one of these URLs would
 * hit a Task 12 deny-route (403), so the embedded empty api_key is inert.
 */

const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const FILE_ID = '22222222-2222-2222-2222-222222222222';

function makeItem(): JellyfinBaseItemDto {
    return {
        Id: ITEM_ID,
        Name: 'Test Movie',
        Type: 'Movie',
        ServerId: 'server-1',
        RunTimeTicks: 36_000_000_000,
    } as JellyfinBaseItemDto;
}

/**
 * Build a fake `postgres.Sql` whose two consecutive tagged-template calls
 * return the file row, then the (empty) stream rows. enrichItemsWithMediaSources
 * makes exactly these two queries; this minimal harness avoids spinning up a
 * real DB.
 */
function makeMockSql(): postgres.Sql {
    let call = 0;
    const fn = (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
        call++;
        if (call === 1) {
            return Promise.resolve([
                {
                    media_item_id: ITEM_ID,
                    file_id: FILE_ID,
                    file_path: '/media/movies/test.mkv',
                    file_size_bytes: 1_500_000_000,
                    total_bitrate: 8_000_000,
                    created_at: new Date('2026-01-01T00:00:00Z'),
                },
            ]);
        }
        return Promise.resolve([]);
    };
    return fn as unknown as postgres.Sql;
}

describe('enrichItemsWithMediaSources with empty apiKey (PAT auth)', () => {
    it('does not crash with empty apiKey and produces well-formed URLs', async () => {
        const items = [makeItem()];
        await enrichItemsWithMediaSources(makeMockSql(), items, '');

        const sources = items[0].MediaSources;
        expect(sources).toBeDefined();
        expect(sources!.length).toBe(1);
        const src = sources![0];
        expect(src.Id).toBe(FILE_ID);

        // URL well-formedness checks: empty-value api_key is allowed (the
        // stream URL is inert metadata for PAT consumers — any actual fetch
        // hits a Task 12 deny-route), but the URL itself must not be malformed.
        const directUrl = src.DirectStreamUrl ?? '';
        const transcodeUrl = src.TranscodingUrl ?? '';
        for (const url of [directUrl, transcodeUrl]) {
            expect(url).not.toContain('&&'); // no orphan ampersand
            expect(url).not.toContain('=undefined'); // no undefined coercion
            expect(url).not.toContain('=null'); // no null coercion
            // Exactly one '?' (query starts once)
            expect((url.match(/\?/g) ?? []).length).toBe(1);
        }

        // The Task 1 audit's specific shape: empty-value api_key as last param.
        expect(directUrl).toMatch(/&api_key=$/);
        expect(transcodeUrl).toMatch(/&api_key=$/);

        // Spot-check non-apiKey segments are intact so we know the rest of
        // the builder still functions when apiKey is empty.
        expect(directUrl).toContain(`/Videos/${ITEM_ID}/stream`);
        expect(directUrl).toContain(`mediaSourceId=${FILE_ID}`);
        expect(transcodeUrl).toContain(`/Videos/${ITEM_ID}/master.m3u8`);
        expect(transcodeUrl).toContain(`MediaSourceId=${FILE_ID}`);
    });

    it('still works with a non-empty apiKey (regression baseline)', async () => {
        const items = [makeItem()];
        await enrichItemsWithMediaSources(makeMockSql(), items, 'abc123');

        const directUrl = items[0].MediaSources![0].DirectStreamUrl ?? '';
        expect(directUrl).toMatch(/&api_key=abc123$/);
    });
});
