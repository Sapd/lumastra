// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { expect, it, vi } from 'vitest';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../../tests/integration/setup/test-database.js';
import type { TrackDetailRow } from '../../../database/queries/music.queries.js';

vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/config.js', () => ({
    features: { autoLyrics: true, musicLyricsFetch: true, saveLyricsToDisk: false },
}));
vi.mock('$lib/server/utils/music-scanner-utils.js', () => ({ writeLyricsSidecar: vi.fn() }));
vi.mock('$lib/server/plugins/runtime/lyrics-providers.js', () => ({
    fetchLyricsFromPlugins: vi.fn().mockResolvedValue(null),
}));
const provider = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/providers/implementations/musicbrainz/lrclib.js', () => ({
    getLyrics: provider,
}));

import { fetchEligibleTrackIds, countEligibleTracks } from './lyrics-lrclib-fetch.js';
import { resolveLyrics } from '../../../services/music/lyrics.service.js';

it('excludes deferred tracks in both sweep queries, retries when due, and preserves misses', async () => {
    const db = getTestDb();
    const schema = `lyrics_retry_${crypto.randomUUID().replaceAll('-', '')}`;
    await db`CREATE SCHEMA ${db(schema)}`;
    const sql = postgres(getTestDatabaseUrl(), { max: 1, connection: { search_path: schema } });
    const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
    try {
        await sql`CREATE TABLE media_items (id uuid PRIMARY KEY, media_type text, has_files boolean,
            custom_metadata jsonb, created_at timestamptz DEFAULT now())`;
        const metadata = [
            {},
            {
                lyricsRetry: {
                    attempts: 3,
                    nextRetryAt: new Date(Date.now() + 86_400_000).toISOString(),
                },
            },
            { lyricsRetry: { attempts: 2, nextRetryAt: new Date(0).toISOString() } },
            { lyrics: { plain: null, synced: null, fetchedAt: new Date().toISOString() } },
            {},
            {},
        ];
        for (const [i, id] of ids.entries()) {
            await sql`INSERT INTO media_items (id,media_type,has_files,custom_metadata)
                VALUES (${id}, ${i === 5 ? 'movie' : 'track'}, ${i !== 4}, ${sql.json(metadata[i])})`;
        }
        expect((await fetchEligibleTrackIds(sql, 50, 0)).map((r) => r.id).sort()).toEqual(
            [ids[0], ids[2]].sort(),
        );
        expect(await countEligibleTracks(sql)).toBe(2);
        const track = {
            id: ids[0],
            title: 'Retry fixture',
            artist_title: 'Artist',
            custom_metadata: {},
        } as TrackDetailRow;
        provider.mockRejectedValue(new TypeError('network unavailable'));
        await expect(resolveLyrics(sql, track)).rejects.toThrow('network unavailable');
        expect(await countEligibleTracks(sql)).toBe(1);
        expect((await fetchEligibleTrackIds(sql, 50, 0)).map((r) => r.id)).toEqual([ids[2]]);
        const [row] = await sql`SELECT custom_metadata FROM media_items WHERE id=${ids[0]}`;
        expect(row.custom_metadata.lyrics).toBeUndefined();
        expect(row.custom_metadata.lyricsRetry.attempts).toBe(1);
        provider.mockClear();
        await resolveLyrics(sql, { ...track, custom_metadata: row.custom_metadata });
        expect(provider).not.toHaveBeenCalled();
        await sql`UPDATE media_items SET custom_metadata=jsonb_set(custom_metadata,
            '{lyricsRetry,nextRetryAt}', to_jsonb('1970-01-01T00:00:00.000Z'::text)) WHERE id=${ids[0]}`;
        expect(await countEligibleTracks(sql)).toBe(2);
        const [due] = await sql`SELECT custom_metadata FROM media_items WHERE id=${ids[0]}`;
        provider.mockResolvedValue(null);
        await resolveLyrics(sql, { ...track, custom_metadata: due.custom_metadata });
        const [done] = await sql`SELECT custom_metadata FROM media_items WHERE id=${ids[0]}`;
        expect(done.custom_metadata.lyrics.fetchedAt).toBeTypeOf('string');
        expect(done.custom_metadata.lyricsRetry).toBeUndefined();
        expect(await countEligibleTracks(sql)).toBe(1);
    } finally {
        await sql.end();
        await db`DROP SCHEMA ${db(schema)} CASCADE`;
    }
});
