// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { readSharingPolicy } from './media-id-listening-sharing.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: { ...actual.config, SOCIAL_TRUST_GROUPS: [], SOCIAL_DEFAULT_AUDIENCE: 'household' },
    };
});

const SUBJECT = '4b000000-0000-4000-8000-00000000d001';
const VIEWER = '4b000000-0000-4000-8000-00000000d002';
const BOOK = '4b000000-0000-4000-8000-00000000b001';
const rollback = new Error('rollback');

describe('listening-sharing policy read model (real SQL)', () => {
    afterAll(closeTestDb);

    it('requires another live, reciprocally opted-in audiobook viewer', async () => {
        await getTestDb()
            .begin(async (raw) => {
                const sql = raw as unknown as postgres.Sql;
                // Temporary tables isolate household reach from unrelated test users.
                await sql`CREATE TEMP TABLE users (
                id uuid PRIMARY KEY, hide_streams boolean DEFAULT true,
                share_audiobook_activity boolean DEFAULT false,
                share_listening_activity boolean DEFAULT false,
                deleted_at timestamptz, disabled_at timestamptz
            ) ON COMMIT DROP`;
                await sql`CREATE TEMP TABLE user_media_share_opt_out (user_id uuid, media_id uuid) ON COMMIT DROP`;
                await sql`INSERT INTO users (id) VALUES (${SUBJECT})`;
                expect(await readSharingPolicy(sql, SUBJECT, BOOK)).toMatchObject({
                    effectiveShared: false,
                    globallyShared: false,
                    shared: true,
                    blockedBy: ['global_sharing_off', 'hidden', 'no_audience'],
                });
                await sql`INSERT INTO users (id, share_audiobook_activity) VALUES (${VIEWER}, true)`;
                expect((await readSharingPolicy(sql, SUBJECT, BOOK))?.blockedBy).not.toContain(
                    'no_audience',
                );
                await sql`UPDATE users SET share_audiobook_activity = false WHERE id = ${VIEWER}`;
                expect((await readSharingPolicy(sql, SUBJECT, BOOK))?.blockedBy).toContain(
                    'no_audience',
                );
                for (const column of ['deleted_at', 'disabled_at']) {
                    await sql`UPDATE users SET share_audiobook_activity = true, ${sql(column)} = now() WHERE id = ${VIEWER}`;
                    expect((await readSharingPolicy(sql, SUBJECT, BOOK))?.blockedBy).toContain(
                        'no_audience',
                    );
                    await sql`UPDATE users SET ${sql(column)} = NULL WHERE id = ${VIEWER}`;
                }
                throw rollback;
            })
            .catch((error: unknown) => {
                if (error !== rollback) throw error;
            });
    });
});
