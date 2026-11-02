// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { findOrCreateMusicArtist } from './media-items.queries';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();

describe('findOrCreateMusicArtist — VA flag', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = postgres(URL, { max: 2 });
    });
    afterAll(async () => {
        await sql.end();
    });

    it('flags a VA-aliased new artist and never flags an ordinary artist', async () => {
        await sql
            .begin(async (tx) => {
                // The 16.132.0 migration seeds (and permanently flags) a
                // canonical "Various Artists" row outside this transaction, so
                // the VA-lookup below would otherwise hit that pre-existing
                // row via the SELECT branch and never exercise the INSERT
                // path this test targets. Soft-delete any active VA-aliased
                // artist row first (rolled back with everything else) so the
                // partial unique index no longer shadows it and
                // findOrCreateMusicArtist is forced to actually INSERT.
                await tx`
                    UPDATE media_items SET status = 'deleted'
                    WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
                      AND regexp_replace(LOWER(TRIM(title)), '[^a-z0-9 ]', '', 'g')
                        = regexp_replace(LOWER(TRIM('Various Artists')), '[^a-z0-9 ]', '', 'g')
                `;

                const vaId = await findOrCreateMusicArtist(tx as unknown as postgres.Sql, {
                    name: 'Çeşitli Sanatçılar',
                });
                const [va] =
                    (await tx`SELECT title, is_various_artists FROM media_items WHERE id = ${vaId}`) as {
                        title: string;
                        is_various_artists: boolean;
                    }[];
                expect(va.title).toBe('Various Artists'); // canonicalized
                expect(va.is_various_artists).toBe(true);

                const akonId = await findOrCreateMusicArtist(tx as unknown as postgres.Sql, {
                    name: 'Arlen',
                });
                // Re-scan the same ordinary artist (hits ON CONFLICT / fallback path).
                const akonId2 = await findOrCreateMusicArtist(tx as unknown as postgres.Sql, {
                    name: 'Arlen',
                });
                expect(akonId2).toBe(akonId);
                const [arlen] =
                    (await tx`SELECT is_various_artists FROM media_items WHERE id = ${akonId}`) as {
                        is_various_artists: boolean;
                    }[];
                expect(arlen.is_various_artists).toBe(false);

                throw new Error('__rollback__');
            })
            .catch((e) => {
                if (e.message !== '__rollback__') throw e;
            });
    });
});
