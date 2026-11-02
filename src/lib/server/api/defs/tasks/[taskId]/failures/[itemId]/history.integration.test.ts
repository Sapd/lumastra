// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for `buildFailureHistory` — the composition function
 * backing GET /api/v1/tasks/{taskId}/failures/{itemId}/history. The GET handler is a
 * thin wrapper (same pattern as `buildRateQueue` in defs/rate/queue.ts), so
 * this exercises real inserted rows against Postgres rather than a mock.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import { recordFailure } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { buildFailureHistory } from './history.js';

const LIBRARY_ROOT = '/data/itest-history-music';

describe('buildFailureHistory (integration)', () => {
    let sql: postgres.Sql;
    let groupId: string;
    let pathId: string;

    beforeAll(async () => {
        sql = getTestDb();

        // Seed a real library_paths row so the redaction chain
        // (getEnabledLibraryPaths → redactPaths) has a root to match against —
        // an empty roots array makes every "not contain the path" assertion
        // pass unconditionally without proving redaction actually ran.
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES ('History IT Group') RETURNING id
        `;
        groupId = group.id;
        const [path] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (media_type, path, enabled, provider, library_group_id)
            VALUES ('music', ${LIBRARY_ROOT}, true, 'tmdb', ${groupId})
            RETURNING id
        `;
        pathId = path.id;
    });

    afterAll(async () => {
        await sql`DELETE FROM library_paths WHERE id = ${pathId}`;
        await sql`DELETE FROM library_groups WHERE id = ${groupId}`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM plugin_failure_events WHERE plugin_id LIKE 'itest_history_%'`;
    });

    it('returns real inserted rows in chronological (oldest-first) order', async () => {
        await recordFailure(sql, 'itest_history_a', 'album-1', 'timeout contacting provider', null);
        await new Promise((r) => setTimeout(r, 20));
        await recordFailure(sql, 'itest_history_a', 'album-1', 'rate limited', null);
        await new Promise((r) => setTimeout(r, 20));
        await recordFailure(sql, 'itest_history_a', 'album-1', 'unexpected 500', null);

        const result = await buildFailureHistory(sql, 'itest_history_a', 'album-1');

        expect(result.pluginId).toBe('itest_history_a');
        expect(result.itemId).toBe('album-1');
        expect(result.events).toHaveLength(3);

        // Chronological order — oldest failure first, matching insertion order.
        expect(result.events[0].reason).toBe('timeout contacting provider');
        expect(result.events[1].reason).toBe('rate limited');
        expect(result.events[2].reason).toBe('unexpected 500');

        expect(result.events[0].occurredAt.getTime()).toBeLessThan(
            result.events[1].occurredAt.getTime(),
        );
        expect(result.events[1].occurredAt.getTime()).toBeLessThan(
            result.events[2].occurredAt.getTime(),
        );
    });

    it('does not leak another item or plugin into the timeline', async () => {
        await recordFailure(sql, 'itest_history_b', 'item-1', 'reason-1', null);
        await recordFailure(sql, 'itest_history_b', 'item-2', 'other-item-reason', null);
        await recordFailure(sql, 'itest_history_c', 'item-1', 'other-plugin-reason', null);

        const result = await buildFailureHistory(sql, 'itest_history_b', 'item-1');

        expect(result.events).toHaveLength(1);
        expect(result.events[0].reason).toBe('reason-1');
    });

    it('returns an empty timeline for an item with no failures', async () => {
        const result = await buildFailureHistory(sql, 'itest_history_a', 'no-such-item');
        expect(result.events).toEqual([]);
    });

    it('redacts an absolute media path in reason server-side, through an apostrophe', async () => {
        // "Guns N' Roses" shape: an apostrophe inside the path used to
        // terminate the old ffmpeg-shaped redactor's match early and leak
        // everything after it (artist/album/track) verbatim.
        const reason =
            `failed to decode ${LIBRARY_ROOT}/Guns N' Roses/Appetite For Destruction/` +
            `01 - Welcome To The Jungle.flac: EOF`;
        await recordFailure(sql, 'itest_history_d', 'track-1', reason, null);

        const result = await buildFailureHistory(sql, 'itest_history_d', 'track-1');

        expect(result.events).toHaveLength(1);
        expect(result.events[0].reason).not.toContain('Guns N');
        expect(result.events[0].reason).not.toContain('Appetite For Destruction');
        expect(result.events[0].reason).not.toContain('Welcome To The Jungle');
        expect(result.events[0].reason).toContain('<media>/<redacted>.flac');

        // The response never carries the roots themselves.
        expect(result).not.toHaveProperty('libraryRoots');
    });

    it('reports truncated: false for a short timeline', async () => {
        await recordFailure(sql, 'itest_history_a', 'album-1', 'one event', null);
        const result = await buildFailureHistory(sql, 'itest_history_a', 'album-1');
        expect(result.truncated).toBe(false);
    });
});
