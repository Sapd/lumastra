// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    buildArtistCreditEvidence,
    resolveArtistCredit,
} from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit.js';
import { reconcileTrackArtistCredits } from './artist-credit-ingestion.js';

const ROLLBACK = new Error('provider-first-fixture-rollback');

async function inRollback(body: (sql: postgres.Sql) => Promise<void>): Promise<void> {
    try {
        await getTestDb().begin(async (tx) => {
            await body(tx);
            throw ROLLBACK;
        });
    } catch (error) {
        if (error !== ROLLBACK) throw error;
    }
}

describe('provider identity precedes scalar credit splitting', () => {
    it.each([false, true])(
        'keeps a known duo indivisible (ambiguous claimant: %s)',
        async (ambiguous) => {
            await inRollback(async (sql) => {
                const suffix = randomUUID();
                const firstName = `Aurum ${suffix}`;
                const secondName = `Estel ${suffix}`;
                const scalar = `${firstName} & ${secondName}`;
                const evidence = buildArtistCreditEvidence([
                    firstName,
                    `${firstName} feat. Guest ${suffix}`,
                    scalar,
                ]);
                // Prove this fixture would split the duo without provider-first resolution.
                expect(resolveArtistCredit(scalar, evidence)).toEqual([firstName, secondName]);
                const mbid = randomUUID();
                const duoId = randomUUID();
                await sql`
                INSERT INTO media_items (id, title, media_type, custom_metadata)
                VALUES (${duoId}::uuid, ${`Canonical Duo ${suffix}`}, 'artist',
                    ${sql.json({ musicbrainz_artist_id: mbid })})
            `;
                for (const title of [firstName, secondName]) {
                    await sql`INSERT INTO media_items (title, media_type) VALUES (${title}, 'artist')`;
                }
                if (ambiguous) {
                    await sql`
                    INSERT INTO media_items (title, media_type, custom_metadata)
                    VALUES (${`Second Claimant ${suffix}`}, 'artist',
                        ${sql.json({ musicbrainz_artist_id: mbid })})
                `;
                }
                const trackId = randomUUID();
                await sql`
                INSERT INTO media_items (id, title, media_type, custom_metadata)
                VALUES (${trackId}::uuid, 'Provider Credit Fixture', 'track',
                    ${sql.json({ artist: scalar, musicbrainz_artist_ids: [mbid] })})
            `;
                await reconcileTrackArtistCredits(sql, trackId, { evidence });
                const [row] = await sql<
                    { credits: { id: string | null; credited_name: string }[] }[]
                >`
                SELECT custom_metadata->'track_artist_credits' AS credits
                FROM media_items WHERE id = ${trackId}::uuid
            `;
                expect(row.credits).toEqual([
                    { id: ambiguous ? null : duoId, credited_name: scalar },
                ]);
            });
        },
    );
});
