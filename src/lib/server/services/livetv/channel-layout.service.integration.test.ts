// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for channel-layout export + import against a real database.
 * Proves the full cycle: export curation, simulate a provider switch, re-import,
 * and verify curation lands on matches, extras append, and missing entries report.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { buildChannelLayout, importChannelLayout } from './channel-layout.service.js';

describe('channel layout export/import', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channels, livetv_categories, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
    });

    async function makeChannel(opts: {
        title: string;
        sourceId: string;
        sortOrder: number;
        isVisible: boolean;
        categoryId?: string | null;
        adminDisplayName?: string | null;
    }): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${id}::uuid, ${opts.title}, 'tvchannel', 'active')
        `;
        await sql`
            INSERT INTO livetv_channels (id, m3u_url, source_id, sort_order, is_visible, category_id, admin_display_name)
            VALUES (${id}::uuid, ${'http://x/' + id}, ${opts.sourceId}::uuid, ${opts.sortOrder},
                    ${opts.isVisible}, ${opts.categoryId ?? null}::uuid, ${opts.adminDisplayName ?? null})
        `;
        return id;
    }

    it('round-trips curation across a simulated provider switch', async () => {
        const [src] = await sql<{ id: string }[]>`
            INSERT INTO livetv_sources (name, source_type) VALUES ('Old', 'm3u') RETURNING id
        `;
        const [news] = await sql<{ id: string }[]>`
            INSERT INTO livetv_categories (name, sort_order) VALUES ('News', 0) RETURNING id
        `;
        const [sport] = await sql<{ id: string }[]>`
            INSERT INTO livetv_categories (name, sort_order) VALUES ('Sport', 1) RETURNING id
        `;

        // Curated channels on the OLD provider.
        const ch1 = await makeChannel({
            title: 'News One HD',
            sourceId: src.id,
            sortOrder: 5,
            isVisible: true,
            categoryId: news.id,
            adminDisplayName: 'My News',
        });
        const ch2 = await makeChannel({
            title: 'Sport Two FHD',
            sourceId: src.id,
            sortOrder: 10,
            isVisible: false,
            categoryId: sport.id,
        });
        await makeChannel({
            title: 'Movie Three',
            sourceId: src.id,
            sortOrder: 15,
            isVisible: true,
        });

        // Export the layout.
        const layout = await buildChannelLayout(sql);
        expect(layout.channels).toHaveLength(3);

        // Simulate switching providers: same two channels return with curation reset,
        // "Movie Three" is gone, and a brand-new channel appears.
        await sql`UPDATE livetv_channels SET sort_order = 0, is_visible = true, category_id = NULL, admin_display_name = NULL WHERE id IN (${ch1}::uuid, ${ch2}::uuid)`;
        await sql`DELETE FROM media_items WHERE title = 'Movie Three'`;
        await makeChannel({
            title: 'Brand New HD',
            sourceId: src.id,
            sortOrder: 0,
            isVisible: true,
        });

        // Re-import.
        const summary = await importChannelLayout(sql, layout);
        expect(summary).toEqual({ matched: 2, appended: 1, notFound: 1 });

        // ch1 curation restored.
        const [r1] = await sql<
            {
                sort_order: number;
                is_visible: boolean;
                admin_display_name: string | null;
                cat: string | null;
            }[]
        >`
            SELECT lc.sort_order, lc.is_visible, lc.admin_display_name, cat.name AS cat
            FROM livetv_channels lc LEFT JOIN livetv_categories cat ON cat.id = lc.category_id
            WHERE lc.id = ${ch1}::uuid
        `;
        expect(r1.sort_order).toBe(5);
        expect(r1.is_visible).toBe(true);
        expect(r1.admin_display_name).toBe('My News');
        expect(r1.cat).toBe('News');

        // ch2 curation restored (hidden, Sport).
        const [r2] = await sql<{ sort_order: number; is_visible: boolean; cat: string | null }[]>`
            SELECT lc.sort_order, lc.is_visible, cat.name AS cat
            FROM livetv_channels lc LEFT JOIN livetv_categories cat ON cat.id = lc.category_id
            WHERE lc.id = ${ch2}::uuid
        `;
        expect(r2.sort_order).toBe(10);
        expect(r2.is_visible).toBe(false);
        expect(r2.cat).toBe('Sport');

        // The new channel was appended after the curated block (maxLayoutSort 15 -> 16).
        const [rNew] = await sql<{ sort_order: number }[]>`
            SELECT lc.sort_order FROM livetv_channels lc
            JOIN media_items mi ON mi.id = lc.id WHERE mi.title = 'Brand New HD'
        `;
        expect(rNew.sort_order).toBe(16);
    });
});
