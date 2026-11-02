// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `loadOwnSessionIds` — the position-freeze exemption for Lumastra's own ABS
 * sessions.
 *
 * This exists because the query shipped filtering on `play_sessions.ended_at`,
 * a column that has never existed on that table (the terminal stamp is
 * `stopped_at`; liveness is `status`). Every ABS pull therefore aborted with
 * `column "ended_at" does not exist` — invisible on an install with no linked
 * users, because the linked-user gate returns before this query runs, and
 * invisible to the type checker because the row type was hand-declared and
 * described a shape the database never had.
 *
 * A unit test with a mocked `sql` would have passed against the broken query.
 * So this runs against a real Postgres, and asserts the PAUSED case explicitly:
 * a paused Lumastra session is precisely the state the exemption exists for
 * (Lumastra holds the ABS session open while the user is paused, and without
 * the exemption the pull that carries their phone's position is frozen by their
 * own laptop and the position never advances).
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { loadOwnSessionIds } from './audiobookshelf.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

describe.skipIf(SKIP)('AudiobookShelf watch-sync — own open sessions', () => {
    let sql: postgres.Sql;
    let userId: string;
    let mediaId: string;
    /** media_items ids inserted by this file, for exact teardown. */
    const seededMediaIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanupSeededBooks();
        await closeTestDb();
    });

    /**
     * Remove the books this file inserted.
     *
     * Without it each case leaves one behind for the lifetime of the test
     * database, and `audiobook-browse.queries.integration.test.ts` asserts an
     * ABSOLUTE title list over the unscoped `media_items` table — so the residue
     * makes that suite fail depending on file order, and the failure reads as a
     * broken visibility filter rather than as leftovers.
     */
    async function cleanupSeededBooks(): Promise<void> {
        if (seededMediaIds.length === 0) return;
        await sql`DELETE FROM media_items WHERE id = ANY(${seededMediaIds}::uuid[])`;
        seededMediaIds.length = 0;
    }

    afterEach(async () => {
        await cleanupSeededBooks();
    });

    beforeEach(async () => {
        // Each case asserts on set SIZE as well as membership, so rows from a
        // previous case would make the assertions meaningless.
        await sql`DELETE FROM play_sessions`;
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        mediaId = randomUUID();
        seededMediaIds.push(mediaId);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${mediaId}::uuid, 'A Book', 'audiobook', 'active', true)
        `;
    });

    async function insertSession(
        source: string,
        status: string,
        sourceSessionId: string | null,
    ): Promise<void> {
        await sql`
            INSERT INTO play_sessions (
                id, media_id, user_id, device_id, ip_address, play_method,
                status, position_ms, source, source_session_id
            ) VALUES (
                ${randomUUID()}::uuid, ${mediaId}::uuid, ${userId}::uuid,
                ${'dev-' + randomUUID()}, '127.0.0.1'::inet, 'direct',
                ${status}, 0, ${source}, ${sourceSessionId}
            )
        `;
    }

    const ctx = () => ({ sql }) as unknown as PluginContext;

    it('returns ACTIVE and PAUSED AudiobookShelf sessions', async () => {
        await insertSession('audiobookshelf', 'ACTIVE', 'abs-active');
        await insertSession('audiobookshelf', 'PAUSED', 'abs-paused');

        const ids = await loadOwnSessionIds(ctx());

        expect(ids.has('abs-active')).toBe(true);
        // The whole point of the exemption — do not "tighten" this to ACTIVE.
        expect(ids.has('abs-paused')).toBe(true);
    });

    it('excludes every terminal status', async () => {
        // The CHECK allows exactly ACTIVE / PAUSED / COMPLETED / KILLED /
        // CRASHED. CRASHED is deliberately excluded too: a crashed session is
        // not one we are still holding open upstream, and treating it as live
        // would freeze that book's position until an operator intervened.
        await insertSession('audiobookshelf', 'COMPLETED', 'abs-completed');
        await insertSession('audiobookshelf', 'KILLED', 'abs-killed');
        await insertSession('audiobookshelf', 'CRASHED', 'abs-crashed');

        const ids = await loadOwnSessionIds(ctx());

        expect(ids.size).toBe(0);
    });

    it('ignores other sources and rows with no upstream session id', async () => {
        // A live Jellyfin session must never exempt an ABS item from the freeze.
        await insertSession('jellyfin', 'ACTIVE', 'jf-session');
        await insertSession('audiobookshelf', 'ACTIVE', null);

        const ids = await loadOwnSessionIds(ctx());

        expect(ids.has('jf-session')).toBe(false);
        expect(ids.size).toBe(0);
    });

    it('runs at all against the real schema', async () => {
        // The regression itself: the query must not reference a column the
        // table does not have. An empty table is enough to catch it.
        await expect(loadOwnSessionIds(ctx())).resolves.toBeInstanceOf(Set);
    });
});
