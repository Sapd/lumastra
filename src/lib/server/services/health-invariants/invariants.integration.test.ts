// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the 'duplicate-artist-groups' health invariant.
 *
 * Verifies grouping now keys off the `is_various_artists` flag rather than an
 * inline VA name-regex, so ANY flagged VA bucket (including foreign-language
 * ones like "Çeşitli Sanatçılar") collapses into the single canonical
 * `various-artists` group instead of forming its own separate group.
 *
 * All scenarios run inside a transaction that is always rolled back (via a
 * thrown sentinel error), so nothing persists in the shared `lumastra_tests`
 * database. The invariant's `sql` param type is `postgres.Sql`, and
 * `postgres.TransactionSql` is structurally assignable to it, so passing
 * `tx` through exercises the real registered invariant against a real DB.
 *
 * Both scenarios below need two 'active' artist rows that normalize to the
 * SAME title (the exact condition the 16.77.0 unique index
 * `uq_music_artist_norm_title` normally forbids — this invariant is a safety
 * net for exactly that kind of pre-existing/legacy duplicate). The index is
 * dropped for the lifetime of the rolled-back transaction only; the DROP is
 * undone by the rollback like every other write here, so the constraint is
 * restored immediately and no other session is affected beyond the brief
 * lock window of this single, fast transaction.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { INVARIANTS } from './invariants.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();

function findInvariant(id: string) {
    const invariant = INVARIANTS.find((i) => i.id === id);
    if (!invariant) throw new Error(`invariant not registered: ${id}`);
    return invariant;
}

async function insertArtist(
    tx: postgres.TransactionSql,
    title: string,
    isVariousArtists: boolean,
): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, is_various_artists)
        VALUES (${title}, 'artist', ${isVariousArtists})
        RETURNING id
    `;
    return row.id;
}

describe("invariant 'duplicate-artist-groups'", () => {
    const invariant = findInvariant('duplicate-artist-groups');
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = postgres(URL, { max: 2 });
    });

    afterAll(async () => {
        await sql.end();
    });

    it('collapses a canonical VA bucket + a foreign-language VA bucket into ONE duplicate group, not two', async () => {
        const suffix = Math.random().toString(36).slice(2, 8);
        const foreignTitle = `Çeşitli Sanatçılar ${suffix}`;

        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                // Neutralize pre-existing flagged VA rows to ensure deterministic count on shared DB.
                await tx`UPDATE media_items SET is_various_artists = false WHERE media_type = 'artist' AND is_various_artists = true`;

                const before = await invariant.query(tx);

                // Both artist identity indexes would reject the duplicates.
                await tx`DROP INDEX IF EXISTS uq_music_artist_norm_title`;
                await tx`DROP INDEX IF EXISTS uq_music_artist_title_nfc`;

                // Two differently-spelled titles that both match the legacy
                // English-only VA regex (old code already groups these two
                // together as one 'various-artists' group on their own).
                await insertArtist(tx, `${suffix}a/VA`, true);
                await insertArtist(tx, `${suffix}b/Various Artists`, true);

                // A foreign-language VA bucket, duplicated. Old code's regex
                // doesn't recognize non-English VA names, so under the
                // pre-change CASE these fall through to the plain
                // regexp_replace ELSE branch and form their OWN separate
                // duplicate group — i.e. 2 total groups (English pair +
                // foreign pair). The flag-based CASE recognizes ALL 4 rows as
                // is_various_artists and merges them into the SAME
                // 'various-artists' bucket — i.e. exactly 1 total group.
                await insertArtist(tx, foreignTitle, true);
                await insertArtist(tx, foreignTitle, true);

                const after = await invariant.query(tx);

                // Exactly ONE new duplicate group (the merged VA bucket) —
                // not two separate ones.
                expect(after).toBe(before + 1);

                throw new Error('__rollback__');
            })
            .catch((e) => {
                if (e instanceof Error && e.message !== '__rollback__') throw e;
            });
    });

    it('still counts two genuinely-duplicate ordinary (unflagged) artists as 1 duplicate group', async () => {
        const suffix = Math.random().toString(36).slice(2, 8);
        const title = `Duplicate Test Artist ${suffix}`;

        await sql
            .begin(async (tx: postgres.TransactionSql) => {
                const before = await invariant.query(tx);

                // Both artist identity indexes would reject the duplicates.
                await tx`DROP INDEX IF EXISTS uq_music_artist_norm_title`;
                await tx`DROP INDEX IF EXISTS uq_music_artist_title_nfc`;

                await insertArtist(tx, title, false);
                await insertArtist(tx, title, false);

                const after = await invariant.query(tx);

                expect(after).toBe(before + 1);

                throw new Error('__rollback__');
            })
            .catch((e) => {
                if (e instanceof Error && e.message !== '__rollback__') throw e;
            });
    });
});
