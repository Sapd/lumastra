// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { listArtistCreditEvidenceSources } from './artist-merge.queries.js';

/**
 * listArtistCreditEvidenceSources reads each track's metadata once
 * (jsonb_to_record) instead of extracting every field from the raw column.
 * These cases pin that it still yields exactly what `->>` / array expansion did.
 */
describe('listArtistCreditEvidenceSources', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    async function track(metadata: unknown, status = 'active'): Promise<void> {
        await sql`
            INSERT INTO media_items (id, title, media_type, status, custom_metadata)
            VALUES (${randomUUID()}::uuid, 'Track', 'track', ${status},
                    ${sql.json(metadata as postgres.JSONValue)})
        `;
    }

    it('collects scalar and array artist tags from active tracks only', async () => {
        const t = randomUUID().slice(0, 8);
        await track({ artist: `Solo ${t}`, album_artist: `Band ${t}` });
        await track({ artists: [`A1 ${t}`, `A2 ${t}`], album_artists: [`AA ${t}`] });
        await track({ artist: '', album_artist: null, artists: 'not-an-array' });
        await track({ artist: 42 }); // non-string scalar: ->> gave '42'
        await track({ artist: [`Arr ${t}`] }); // array in the scalar field: ->> gave its JSON text
        await track({ artist: `Gone ${t}` }, 'deleted');
        // A non-object document: ->> was NULL, jsonb_to_record would raise.
        await track([`Weird ${t}`]);

        const { tags } = await listArtistCreditEvidenceSources(sql);
        const mine = tags.filter((tag) => tag.includes(t) || tag === '42').sort();
        expect(mine).toEqual(
            [
                `A1 ${t}`,
                `A2 ${t}`,
                `AA ${t}`,
                `Band ${t}`,
                `Solo ${t}`,
                '42',
                `["Arr ${t}"]`,
            ].sort(),
        );
        expect(tags).not.toContain('');
    });
});
