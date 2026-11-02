// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    collaborationNeedsReviewSql,
    collaborationFingerprintsSql,
    upgradeReviewedCollaborationFingerprints,
    collaborationFingerprintSql,
    getCollaborationFingerprint,
} from './collaboration-review.queries.js';
import {
    baselineFingerprintSql,
    baselineNeedsReviewSql,
} from './hotspot-baselines.test-support.js';

const rollback = new Error('rollback collaboration fixtures');

describe('Collaboration review SQL', () => {
    it('carries forward current legacy choices but does not certify a stale or unknown disposition', async () => {
        try {
            await getTestDb().begin(async (raw) => {
                const tx = raw as unknown as postgres.Sql;
                const good = crypto.randomUUID();
                const stale = crypto.randomUUID();
                await tx`INSERT INTO media_items(id,title,media_type) VALUES (${good},'Cedar & Vale','artist'),(${stale},'Maple & Finch','artist')`;
                const release = crypto.randomUUID();
                await tx`INSERT INTO media_items(id,title,media_type,parent_id) VALUES (${release},'Invented Lanterns','album',${good})`;
                await tx`INSERT INTO media_items(title,media_type,parent_id,custom_metadata) VALUES ('First Lantern','track',${release},'{"artist":"Cedar & Vale"}'::jsonb)`;
                const artists = tx`SELECT id,title,custom_metadata FROM media_items WHERE id=ANY(${[good, stale]}::uuid[])`;
                const old = await tx<
                    { id: string; fingerprint: string }[]
                >`${collaborationFingerprintsSql(tx, artists, false, true)}`;
                await tx`UPDATE media_items SET custom_metadata=jsonb_build_object('collaboration_reviewed',${old.find((r) => r.id === good)!.fingerprint}::text) WHERE id=${good}`;
                await tx`UPDATE media_items SET custom_metadata='{"collaboration_reviewed":"unknown-stale-input"}'::jsonb WHERE id=${stale}`;
                await upgradeReviewedCollaborationFingerprints(tx);
                const [stored] =
                    await tx`SELECT custom_metadata->>'collaboration_reviewed' AS value FROM media_items WHERE id=${good}`;
                expect(stored.value).toBe(await getCollaborationFingerprint(tx, good));
                expect(stored.value).not.toBe(old.find((r) => r.id === good)!.fingerprint);
                expect(
                    (
                        await tx`SELECT custom_metadata->>'collaboration_reviewed' AS value FROM media_items WHERE id=${stale}`
                    )[0].value,
                ).toBe('unknown-stale-input');
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });

    it('preserves fingerprints, credit containment and fresh invalidation across every membership path', async () => {
        try {
            await getTestDb().begin(async (transaction) => {
                const tx = transaction as unknown as postgres.Sql;
                const artist = crypto.randomUUID();
                const album = crypto.randomUUID();
                await tx`INSERT INTO media_items (id,title,media_type,has_files)
                    VALUES (${artist},'Cedar feat. Lumen','artist',true)`;
                await tx`INSERT INTO media_items (id,title,media_type,parent_id)
                    VALUES (${album},'Woven Light','album',${artist})`;
                const trackIds: string[] = [];
                for (const key of [
                    'additional_artist_ids',
                    'file_artist_ids',
                    'album_artist_ids',
                    'remixer_artist_ids',
                    'title_remixer_artist_ids',
                    'independent_remixer_artist_ids',
                    'track_artist_credits',
                    'track_remixer_credits',
                ]) {
                    for (const value of [
                        null,
                        artist,
                        [artist, artist],
                        [{ id: artist, role: 'guest' }],
                        [[artist]],
                        [{ id: [artist] }],
                        [artist.toUpperCase()],
                        [],
                    ]) {
                        const id = crypto.randomUUID();
                        trackIds.push(id);
                        await tx`INSERT INTO media_items (id,title,media_type,parent_id,custom_metadata)
                            VALUES (${id},${'Signal ' + trackIds.length},'track',
                                ${trackIds.length % 3 === 0 ? album : null},${tx.json({ [key]: value })})`;
                    }
                }
                const compare = async (): Promise<string> => {
                    const [old] = await tx`SELECT ${baselineFingerprintSql(tx, 'mi')} AS value
                        FROM media_items mi WHERE id=${artist}`;
                    const current = await getCollaborationFingerprint(tx, artist);
                    expect(current).toBe(old.value);
                    return current!;
                };
                const initial = await compare();
                await tx`UPDATE media_items SET custom_metadata=jsonb_build_object('collaboration_reviewed',${initial}::text)
                    WHERE id=${artist}`;
                const queue = () => tx`SELECT id FROM media_items mi WHERE id=${artist}
                    AND ${collaborationNeedsReviewSql(tx, 'mi')}`;
                expect(await queue()).toHaveLength(0);
                await transaction.savepoint(async (sub) => {
                    await sub`UPDATE media_items SET title='Renamed signal',custom_metadata=custom_metadata || '{"genre":"Ambient"}'::jsonb WHERE id=${trackIds[2]}`;
                    await sub`UPDATE media_items SET overview='New description' WHERE id=${album}`;
                });
                await tx`UPDATE media_files SET probed_at=clock_timestamp()`;
                expect(await compare()).toBe(initial);
                expect(await queue()).toHaveLength(0);
                // A subtransaction gives the edited tuple a new xmin, as a committed scanner write would.
                await transaction.savepoint(async (sub) => {
                    await sub`UPDATE media_items SET custom_metadata=custom_metadata || '{"artist":"Changed credit tag"}'::jsonb WHERE id=${trackIds[2]}`;
                });
                expect(await compare()).not.toBe(initial);
                expect(await queue()).toHaveLength(1);
                const expected = await tx`SELECT id FROM media_items mi WHERE id=${artist}
                    AND ${baselineNeedsReviewSql(tx, 'mi')}`;
                expect(await queue()).toEqual(expected);
                await tx`UPDATE media_items SET status='deleted' WHERE id=${trackIds[2]}`;
                await compare();
                await tx`UPDATE media_items SET canonical_id=${trackIds[0]} WHERE id=${trackIds[3]}`;
                await compare();
                // Queue semantics also cover reviewed artists outside active status.
                await tx`UPDATE media_items SET status='deleted' WHERE id=${artist}`;
                const [fingerprints] = await tx`SELECT
                    ${baselineFingerprintSql(tx, 'mi')} AS before,
                    ${collaborationFingerprintSql(tx, 'mi')} AS after
                    FROM media_items mi WHERE id=${artist}`;
                expect(fingerprints.after).toBe(fingerprints.before);
                await tx`UPDATE media_items SET custom_metadata=jsonb_build_object(
                    'collaboration_reviewed',${fingerprints.before}::text) WHERE id=${artist}`;
                expect(await queue()).toHaveLength(0);
                await tx`UPDATE media_items SET title='Changed inactive artist' WHERE id=${artist}`;
                expect(await queue()).toHaveLength(1);
                expect(await queue()).toEqual(
                    await tx`SELECT id FROM media_items mi WHERE id=${artist}
                    AND ${baselineNeedsReviewSql(tx, 'mi')}`,
                );
                throw rollback;
            });
        } catch (error) {
            if (error !== rollback) throw error;
        }
    });
});
