// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';
import { getImageDescriptorOwners } from '../../database/queries/image-descriptor.queries.js';
import { upsertLocalArtwork } from '../../database/queries/media-artwork.queries.js';
import { resolveImageSpecsForOwner } from '../../services/image-descriptor/resolver.js';
import { currentImageTag, jellyfinImageTag } from './image-enrichment.js';

it('checks the served canonical revision in one statement and rejects a changed revision', async () => {
    const queries: string[] = [];
    const sql = postgres(getTestDatabaseUrl(), {
        max: 1,
        debug: (_c, query) => {
            queries.push(query);
        },
    });
    const id = crypto.randomUUID();
    try {
        await sql`INSERT INTO media_items (id,title,media_type,status) VALUES (${id},'Image snapshot fixture','movie','active')`;
        await upsertLocalArtwork(sql, {
            mediaItemId: id,
            artworkType: 'poster',
            filePath: '/fictional/poster.jpg',
        });
        const owners = await getImageDescriptorOwners(sql, [id]);
        const owner = owners.find((r) => r.id === id)!;
        const specs = resolveImageSpecsForOwner(owner, new Map(owners.map((r) => [r.id, r])), {
            inherit: 'none',
        });
        const revision = (specs.primary ?? specs.poster)!.revision;
        const expected = jellyfinImageTag(id, 'Primary', `canonical:${revision}`);
        const times: number[] = [];
        queries.length = 0;
        for (let i = 0; i < 3; i++) {
            const start = performance.now();
            expect(await currentImageTag(sql, id, 'Primary', revision)).toBe(expected);
            times.push(performance.now() - start);
        }
        console.log(
            'IMAGE_TAG_SNAPSHOT_PROOF',
            JSON.stringify({
                times,
                median: [...times].sort((a, b) => a - b)[1],
                statementsPerRead: queries.length / 3,
            }),
        );
        expect(queries).toHaveLength(3);
        expect(queries.every((q) => q.includes('descriptor_owners AS MATERIALIZED'))).toBe(true);
        await sql`UPDATE image_candidates SET local_content_hash=${'b'.repeat(64)} WHERE media_item_id=${id}`;
        expect(await currentImageTag(sql, id, 'Primary', revision)).toBeNull();
    } finally {
        await sql`DELETE FROM media_items WHERE id=${id}`;
        await sql.end();
    }
});
