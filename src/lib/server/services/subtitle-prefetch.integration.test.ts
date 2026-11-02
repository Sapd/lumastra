// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { getNextEpisodeWithFile } from '$lib/server/database/queries/media-hierarchy.queries.js';
import {
    prefetchNextEpisodeSubtitle,
    resetSubtitlePrefetchState,
} from './subtitle-prefetch.service.js';

describe('next-episode subtitle prefetch', () => {
    let sql: postgres.Sql;
    let n = 0;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        resetSubtitlePrefetchState();
    });

    async function item(
        type: string,
        parentId: string | null,
        seasonNumber: number | null = null,
        episodeNumber: number | null = null,
    ): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id, season_number, episode_number)
            VALUES (${type}, 'Fixture', 'active', ${type === 'episode'}, ${parentId},
                    ${seasonNumber}, ${episodeNumber})
            RETURNING id`;
        return row.id;
    }

    async function withFile(itemId: string): Promise<string> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${`/prefetch/${n++}.mkv`}) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                  VALUES (${f.id}::uuid, ${itemId}::uuid, true)`;
        return f.id;
    }

    async function subtitle(
        fileId: string,
        index: number,
        language: string,
        codec = 'ass',
        opts: { forced?: boolean; title?: string } = {},
    ): Promise<void> {
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, codec, language, is_forced, title, is_text_subtitle)
            VALUES (${fileId}::uuid, 'subtitle', ${index}, ${codec}, ${language},
                    ${opts.forced ?? false}, ${opts.title ?? null}, ${codec !== 'hdmv_pgs_subtitle'})`;
    }

    it('orders by season then episode, crosses seasons, skips fileless and specials', async () => {
        const series = await item('tv', null);
        const s1 = await item('season', series, 1);
        const s2 = await item('season', series, 2);
        const s0 = await item('season', series, 0);
        const e1 = await item('episode', s1, 1, 1);
        const e2 = await item('episode', s1, 1, 2);
        const e3NoFile = await item('episode', s1, 1, 3);
        await sql`UPDATE media_items SET has_files = false WHERE id = ${e3NoFile}::uuid`;
        const s2e1 = await item('episode', s2, 2, 1);
        const sp1 = await item('episode', s0, 0, 1);
        const sp2 = await item('episode', s0, 0, 2);
        for (const id of [e1, e2, s2e1, sp1, sp2]) await withFile(id);

        expect((await getNextEpisodeWithFile(sql, e1))?.id).toBe(e2);
        expect((await getNextEpisodeWithFile(sql, e2))?.id).toBe(s2e1);
        expect(await getNextEpisodeWithFile(sql, s2e1)).toBeNull();
        expect((await getNextEpisodeWithFile(sql, sp1))?.id).toBe(sp2);
        expect(await getNextEpisodeWithFile(sql, sp2)).toBeNull();
        expect(await getNextEpisodeWithFile(sql, series)).toBeNull();
    });

    it("warms the next episode's matching track (same language/kind), once", async () => {
        const series = await item('tv', null);
        const s1 = await item('season', series, 1);
        const e1 = await item('episode', s1, 1, 1);
        const e2 = await item('episode', s1, 1, 2);
        const f1 = await withFile(e1);
        const f2 = await withFile(e2);
        await subtitle(f1, 3, 'eng');
        await subtitle(f1, 4, 'ger', 'ass', { title: 'Full' });
        await subtitle(f2, 2, 'eng');
        await subtitle(f2, 5, 'ger', 'ass', { forced: true, title: 'Signs' });
        await subtitle(f2, 6, 'ger', 'hdmv_pgs_subtitle', { title: 'Full' });
        await subtitle(f2, 7, 'ger', 'ass', { title: 'Full' });

        const resolve = vi.fn().mockResolvedValue({ content: 'x', contentType: 'text/x-ssa' });
        const req = { mediaItemId: e1, fileId: f1, streamIndex: 4, format: 'ass' as const };
        await prefetchNextEpisodeSubtitle(sql, req, { delayMs: 0, resolve });
        await prefetchNextEpisodeSubtitle(sql, req, { delayMs: 0, resolve });

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith(sql, e2, 7, { fileId: f2, format: 'ass' });
    });

    it('retries a prefetch whose extraction produced nothing', async () => {
        const series = await item('tv', null);
        const s1 = await item('season', series, 1);
        const e1 = await item('episode', s1, 1, 1);
        const e2 = await item('episode', s1, 1, 2);
        const f1 = await withFile(e1);
        const f2 = await withFile(e2);
        await subtitle(f1, 3, 'eng');
        await subtitle(f2, 3, 'eng');

        const resolve = vi.fn().mockResolvedValue(null);
        const req = { mediaItemId: e1, fileId: f1, streamIndex: 3, format: 'ass' as const };
        await prefetchNextEpisodeSubtitle(sql, req, { delayMs: 0, resolve });
        await prefetchNextEpisodeSubtitle(sql, req, { delayMs: 0, resolve });

        expect(resolve).toHaveBeenCalledTimes(2);
    });

    it('does nothing when the next episode has no track in that language', async () => {
        const series = await item('tv', null);
        const s1 = await item('season', series, 1);
        const e1 = await item('episode', s1, 1, 1);
        const e2 = await item('episode', s1, 1, 2);
        const f1 = await withFile(e1);
        const f2 = await withFile(e2);
        await subtitle(f1, 3, 'ger');
        await subtitle(f2, 3, 'eng');

        const resolve = vi.fn();
        await prefetchNextEpisodeSubtitle(
            sql,
            { mediaItemId: e1, fileId: f1, streamIndex: 3, format: 'ass' },
            { delayMs: 0, resolve },
        );
        expect(resolve).not.toHaveBeenCalled();
    });
});
