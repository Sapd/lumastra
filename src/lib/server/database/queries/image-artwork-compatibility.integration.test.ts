// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { getLocalArtworkPaths } from './image-sync.queries.js';
import { selectImageCandidate } from './image-candidates.queries.js';
import { upsertLocalArtworkWithOutcome } from './media-artwork.queries.js';

let sql: postgres.Sql;
const rollback = new Error('rollback fixture');
async function fixture(run: (tx: postgres.Sql, id: string) => Promise<void>): Promise<void> {
    try {
        await sql.begin(async (raw) => {
            const tx = raw as unknown as postgres.Sql;
            const id = randomUUID();
            await tx`INSERT INTO media_items (id,title,media_type) VALUES (${id},'Compatibility fixture','movie')`;
            await run(tx, id);
            throw rollback;
        });
    } catch (error) {
        if (error !== rollback) throw error;
    }
}

describe('image artwork compatibility', () => {
    it.each([true, false])(
        'consolidates an existing automatic same-file alias and managed target on tagged=%s replay',
        async (tagged) =>
            fixture(async (tx, id) => {
                const filePath = '/real/coexisting.jpg';
                await tx`SELECT register_image_candidate(${id},'poster','local-folder',${filePath},${filePath})`;
                await tx`SELECT register_image_candidate(${id},'poster','tmdb',${filePath},${filePath},'provider:tmdb')`;
                const [target] = await tx<
                    { id: string }[]
                >`SELECT id FROM image_candidates WHERE media_item_id=${id} AND provider='tmdb'`;
                await upsertLocalArtworkWithOutcome(tx, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath,
                    ...(tagged ? { sourceTag: 'provider:tmdb' } : {}),
                });
                expect(
                    await tx`SELECT id,provider,selected FROM image_candidates WHERE media_item_id=${id}`,
                ).toEqual([{ id: target.id, provider: 'tmdb', selected: true }]);
            }),
    );

    it.each([true, false])(
        'repairs coexisting aliases through the top-level no-op path tagged=%s',
        async (tagged) => {
            const id = randomUUID(),
                filePath = '/real/top-level-alias.jpg';
            await sql`INSERT INTO media_items(id,title,media_type) VALUES(${id},${id},'movie')`;
            try {
                await sql`SELECT register_image_candidate(${id},'poster','local-folder',${filePath},${filePath})`;
                await sql`SELECT register_image_candidate(${id},'poster','tmdb',${filePath},${filePath},'provider:tmdb')`;
                await sql`UPDATE media_items SET custom_poster_url=${`/api/image/custom/${id}/poster`} WHERE id=${id}`;
                expect(
                    await upsertLocalArtworkWithOutcome(sql, {
                        mediaItemId: id,
                        artworkType: 'poster',
                        filePath,
                        ...(tagged ? { sourceTag: 'provider:tmdb' } : {}),
                    }),
                ).toBe('updated');
                expect(
                    await sql`SELECT provider,selected FROM image_candidates WHERE media_item_id=${id}`,
                ).toEqual([{ provider: 'tmdb', selected: true }]);
            } finally {
                await sql`DELETE FROM media_items WHERE id=${id}`;
            }
        },
    );

    it('preserves a manually selected unlocked tagless local-folder candidate during same-file managed registration', async () =>
        fixture(async (tx, id) => {
            const params = {
                mediaItemId: id,
                artworkType: 'poster' as const,
                filePath: '/real/manual-unlocked.jpg',
            };
            await upsertLocalArtworkWithOutcome(tx, params);
            const [manual] = await tx<
                { id: string }[]
            >`SELECT id FROM image_candidates WHERE media_item_id=${id}`;
            await selectImageCandidate(tx, id, manual.id, false, true);
            const before =
                await tx`SELECT id,provider,provider_ref,chosen_by,locked,selected FROM image_candidates WHERE id=${manual.id}`;
            await upsertLocalArtworkWithOutcome(tx, { ...params, sourceTag: 'provider:tmdb' });
            expect(
                await tx`SELECT id,provider,provider_ref,chosen_by,locked,selected FROM image_candidates WHERE id=${manual.id}`,
            ).toEqual(before);
        }));

    it.each([true, false])(
        'keeps a different-path unlocked manual selection across alias migration targetExists=%s',
        async (targetExists) =>
            fixture(async (tx, id) => {
                const shared = '/real/automatic.jpg';
                await tx`SELECT register_image_candidate(${id},'poster','local-folder',${shared},${shared})`;
                if (targetExists)
                    await tx`SELECT register_image_candidate(${id},'poster','tmdb',${shared},${shared},'provider:tmdb')`;
                await tx`SELECT register_image_candidate(${id},'poster','deezer','manual-choice','/real/manual-other.jpg')`;
                const [manual] = await tx<
                    { id: string }[]
                >`SELECT id FROM image_candidates WHERE media_item_id=${id} AND provider='deezer'`;
                await tx`UPDATE media_items SET custom_poster_url=${`/api/image/custom/${id}/poster`} WHERE id=${id}`;
                await selectImageCandidate(tx, id, manual.id, false, true);
                await tx`UPDATE image_candidates SET selection_order=9 WHERE id=${manual.id}`;
                const before =
                    await tx`SELECT id,selected,selection_order,chosen_by,locked FROM image_candidates WHERE media_item_id=${id} ORDER BY id`;
                await upsertLocalArtworkWithOutcome(tx, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath: shared,
                    sourceTag: 'provider:tmdb',
                });
                expect(
                    await tx`SELECT id,selected,selection_order,chosen_by,locked FROM image_candidates WHERE media_item_id=${id} ORDER BY id`,
                ).toEqual(before);
                await upsertLocalArtworkWithOutcome(tx, {
                    mediaItemId: id,
                    artworkType: 'poster',
                    filePath: shared,
                });
                expect(
                    await tx`SELECT id,selected,selection_order,chosen_by,locked FROM image_candidates WHERE media_item_id=${id} ORDER BY id`,
                ).toEqual(before);
            }),
    );

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('normalizes new legacy URL captures while retaining a real provider disk cache', async () => {
        await fixture(async (tx, id) => {
            const url = 'https://image.tmdb.org/t/p/original/new.jpg';
            await tx`INSERT INTO media_artwork (media_item_id,artwork_type,source,file_path)
                VALUES (${id},'poster','tmdb',${url}), (${id},'backdrop','tmdb','/real/provider-cache.jpg')`;
            expect(
                await tx`SELECT source,file_path,provider,provider_ref,remote_url FROM image_candidates
                WHERE media_item_id = ${id} AND artwork_type = 'poster'`,
            ).toEqual([
                {
                    source: 'remote',
                    file_path: null,
                    provider: 'tmdb',
                    provider_ref: url,
                    remote_url: url,
                },
            ]);
            expect(
                await tx`SELECT file_path,remote_url FROM media_artwork WHERE media_item_id = ${id} AND artwork_type = 'poster'`,
            ).toEqual([
                {
                    file_path: null,
                    remote_url: url,
                },
            ]);
            expect((await getLocalArtworkPaths(tx, [id])).map((row) => row.file_path)).toEqual([
                '/real/provider-cache.jpg',
            ]);
        });
    });

    it('upgrades only an unlabelled automatic alias of the same file and preserves manual choices and suppressions', async () => {
        await fixture(async (tx, id) => {
            const params = {
                mediaItemId: id,
                artworkType: 'poster' as const,
                filePath: '/real/sidecar.jpg',
            };
            expect(await upsertLocalArtworkWithOutcome(tx, params)).toBe('inserted');
            const [before] = await tx<
                { id: string }[]
            >`SELECT id FROM image_candidates WHERE media_item_id = ${id}`;
            expect(
                await upsertLocalArtworkWithOutcome(tx, { ...params, sourceTag: 'provider:tmdb' }),
            ).toBe('updated');
            expect(
                await tx`SELECT id,provider,remote_url FROM image_candidates WHERE media_item_id = ${id}`,
            ).toEqual([
                {
                    id: before.id,
                    provider: 'tmdb',
                    remote_url: 'provider:tmdb',
                },
            ]);
            expect(await upsertLocalArtworkWithOutcome(tx, params)).toBe('unchanged');
            await upsertLocalArtworkWithOutcome(tx, {
                ...params,
                filePath: '/real/manual.jpg',
                sourceTag: 'admin:upload',
            });
            await upsertLocalArtworkWithOutcome(tx, { ...params, sourceTag: 'provider:discogs' });
            expect(
                await tx`SELECT file_path,provider,locked FROM image_candidates WHERE media_item_id = ${id} AND selected`,
            ).toEqual([
                {
                    file_path: '/real/manual.jpg',
                    provider: 'upload',
                    locked: true,
                },
            ]);
            await tx`INSERT INTO image_provider_suppressions (owner,provider,role) VALUES (${id},'deezer','poster')`;
            expect(
                await upsertLocalArtworkWithOutcome(tx, {
                    ...params,
                    sourceTag: 'provider:deezer',
                }),
            ).toBe('suppressed');
            expect(
                await tx`SELECT id FROM image_candidates WHERE media_item_id = ${id} AND provider = 'deezer'`,
            ).toHaveLength(0);
            expect(
                await tx`SELECT file_path FROM image_candidates WHERE media_item_id = ${id}`,
            ).toHaveLength(3);
        });
    });
});
