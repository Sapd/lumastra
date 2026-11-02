// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres cover for the Live TV failure log. The listing query joins
 * `media_items` for the channel title (a channel IS a tvchannel media_item;
 * `livetv_channels` has no name column), and nothing but a live database can
 * catch a wrong column there — tsgo does not read SQL strings.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    recordLiveTvFailureEvent,
    listLiveTvFailureEvents,
    pruneLiveTvFailureEvents,
    type LiveTvFailureEventInput,
} from './livetv-failure-events.queries.js';

const base: LiveTvFailureEventInput = {
    eventUid: 'uid-1',
    channelId: 'ch-1',
    occurredAt: new Date().toISOString(),
    source: 'ingest',
    outcome: 'crashed',
    exitCode: 1,
    signal: null,
    rungId: null,
    stderrTail: 'Server returned 404 Not Found',
    probe: { success: false, error: 'timeout' },
    decision: { videoAction: 'transcode' },
};

describe('livetv-failure-events queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`TRUNCATE livetv_stream_failure_events`;
    });

    it('stores and reads back a row, stripping secrets from stderr and probe', async () => {
        await recordLiveTvFailureEvent(sql, {
            ...base,
            stderrTail: "Opening 'http://iptv/live.ts?token=SEKRET' for reading",
            probe: { url: 'http://iptv/live.ts?token=SEKRET' },
        });

        const rows = await listLiveTvFailureEvents(sql, 10);
        expect(rows).toHaveLength(1);
        expect(rows[0].stderr_tail).toContain('token=<redacted>');
        expect(rows[0].stderr_tail).not.toContain('SEKRET');
        expect(JSON.stringify(rows[0].probe_dump)).not.toContain('SEKRET');
        expect(rows[0].source).toBe('ingest');
        expect(rows[0].exit_code).toBe(1);
        // No matching channel row — the name must degrade to null, not error.
        expect(rows[0].channel_name).toBeNull();
    });

    it('is idempotent on event_uid so a re-drained batch cannot duplicate', async () => {
        // True only for the call that inserted the row: the drain counts feed health on it.
        expect(await recordLiveTvFailureEvent(sql, base)).toBe(true);
        expect(await recordLiveTvFailureEvent(sql, base)).toBe(false);

        expect(await listLiveTvFailureEvents(sql, 10)).toHaveLength(1);
    });

    it('prunes rows older than the cutoff', async () => {
        await recordLiveTvFailureEvent(sql, {
            ...base,
            occurredAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
        });
        await recordLiveTvFailureEvent(sql, { ...base, eventUid: 'uid-2' });

        const deleted = await pruneLiveTvFailureEvents(sql, new Date(Date.now() - 86_400_000));

        expect(deleted).toBe(1);
        expect(await listLiveTvFailureEvents(sql, 10)).toHaveLength(1);
    });
});
