// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    recordTranscodeFailureEvent,
    listFailureIncidents,
    listIncidentSessions,
    listSessionChain,
    saveProbeDump,
    pruneTranscodeFailureEvents,
    countFailedSessions24h,
    deleteFailureIncidents,
} from './transcode-failure-events.queries.js';

const base = {
    jobId: 'job-1',
    playSessionId: 'sess-1',
    attempt: 1,
    outcome: 'failed' as const,
    exitCode: 218,
    signal: null,
    category: 'gpu-init',
    summary: 'boom',
    argv: ['-i', '/data/movies/x.mkv'],
    stderrTail: 'stderr',
    encoder: 'h264_qsv',
    hwaccel: 'qsv',
    mediaId: null,
    fileId: null,
    source: { codec: 'hevc' },
    decision: { useGpu: true },
    env: { appVersion: '1.0.0' },
    transcodeSpeed: null,
};

describe('transcode-failure-events queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // media_files CASCADE clears transcode_failure_events.file_id too — the
        // explicit TRUNCATE of transcode_failure_events still catches rows whose
        // file_id is null and wouldn't be reached by the CASCADE.
        await sql`TRUNCATE transcode_failure_events`;
        await sql.unsafe('TRUNCATE TABLE media_files CASCADE');
    });

    it('stores and reads back a row, stripping secrets from argv and stderr', async () => {
        await recordTranscodeFailureEvent(sql, {
            ...base,
            argv: ['-i', 'http://jf/s?api_key=SEKRET'],
            stderrTail: "Opening 'http://jf/s?api_key=SEKRET'",
        });

        const chain = await listSessionChain(sql, 'sess-1');
        expect(chain).toHaveLength(1);
        expect(JSON.stringify(chain[0].argv)).not.toContain('SEKRET');
        expect(chain[0].stderr_tail).not.toContain('SEKRET');
    });

    it('never throws on a bad row — the transcode path must not unwind', async () => {
        await expect(
            recordTranscodeFailureEvent(sql, { ...base, outcome: 'not-a-real-outcome' as never }),
        ).resolves.toBeUndefined();
    });

    // files=1 is a bad file; files=200 is a bad system. Those must not look alike.
    it('counts DISTINCT files per incident group', async () => {
        const fileA = (
            await sql`INSERT INTO media_files (file_path) VALUES ('/a.mkv') RETURNING id`
        )[0].id;
        const fileB = (
            await sql`INSERT INTO media_files (file_path) VALUES ('/b.mkv') RETURNING id`
        )[0].id;
        await recordTranscodeFailureEvent(sql, { ...base, fileId: fileA });
        await recordTranscodeFailureEvent(sql, { ...base, fileId: fileA });
        await recordTranscodeFailureEvent(sql, { ...base, fileId: fileB });

        const { rows } = await listFailureIncidents(sql, { outcomes: ['failed'], limit: 10 });
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].occurrences)).toBe(3);
        expect(Number(rows[0].distinct_files)).toBe(2);
    });

    it('does not collapse null-file preview jobs into one mega-group', async () => {
        await recordTranscodeFailureEvent(sql, { ...base, fileId: null });
        await recordTranscodeFailureEvent(sql, { ...base, fileId: null });
        const { rows } = await listFailureIncidents(sql, { outcomes: ['failed'], limit: 10 });
        expect(Number(rows[0].distinct_files)).toBe(0);
    });

    // A retry storm against one file is ONE problem, not 6500.
    it('counts distinct sessions, not rows, for the 24h invariant', async () => {
        await recordTranscodeFailureEvent(sql, { ...base, playSessionId: 's1' });
        await recordTranscodeFailureEvent(sql, { ...base, playSessionId: 's1', attempt: 2 });
        await recordTranscodeFailureEvent(sql, { ...base, playSessionId: 's2' });
        expect(await countFailedSessions24h(sql)).toBe(2);
    });

    it('excludes recovered outcomes from the 24h failure count', async () => {
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 's3',
            outcome: 'retried',
        });
        expect(await countFailedSessions24h(sql)).toBe(0);
    });

    // The 24h invariant must agree with the admin page's Failed tab
    // (listFailureIncidents), which counts every FAILED_OUTCOMES member, not
    // just 'failed' — a kernel-OOM SIGKILL ('killed') or a broken FFMPEG_PATH
    // after an upgrade ('spawn_failed') are exactly the incidents this
    // invariant exists to catch.
    it.each(['killed', 'spawn_failed'] as const)(
        'counts a %s outcome toward the 24h failure invariant',
        async (outcome) => {
            await recordTranscodeFailureEvent(sql, {
                ...base,
                playSessionId: `sess-${outcome}`,
                outcome,
            });
            expect(await countFailedSessions24h(sql)).toBe(1);
        },
    );

    it('caches the probe dump on the row and strips secrets from it', async () => {
        await recordTranscodeFailureEvent(sql, base);
        const [row] = await listSessionChain(sql, 'sess-1');
        await saveProbeDump(sql, row.id, "Input #0 from 'http://jf/s?api_key=SEKRET'");
        const [after] = await listSessionChain(sql, 'sess-1');
        expect(after.probe_dump).not.toContain('SEKRET');
        expect(after.probed_at).not.toBeNull();
    });

    // A probe that produces nothing (deleted file, unmounted volume, timeout) must
    // still be cached — otherwise the null result is never cached and every later
    // detail view for the same row re-spawns ffmpeg.
    it('caches a null probe result — probed_at is set even when the dump is null', async () => {
        await recordTranscodeFailureEvent(sql, base);
        const [row] = await listSessionChain(sql, 'sess-1');
        await saveProbeDump(sql, row.id, null);
        const [after] = await listSessionChain(sql, 'sess-1');
        expect(after.probe_dump).toBeNull();
        expect(after.probed_at).not.toBeNull();
    });

    // stderr_tail is bounded by MAX_STDERR_CHARS, but nothing previously bounded a
    // single argv element — a pathological filter chain could bloat a row well past
    // what retention sizing assumed.
    it('bounds each argv element without dropping any element', async () => {
        const hugeElement = 'x'.repeat(10_000);
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 'sess-huge-argv',
            argv: ['-i', hugeElement, '-c:v', 'hevc_qsv'],
        });
        const [row] = await listSessionChain(sql, 'sess-huge-argv');
        expect(row.argv).toHaveLength(4);
        expect(row.argv[1].length).toBeLessThan(10_000);
        expect(row.argv[3]).toBe('hevc_qsv');
    });

    // `encoder IS NOT DISTINCT FROM` exists for exactly this: a software incident's
    // `encoder` is NULL, and `NULL = NULL` is never true in SQL, so a plain `=`
    // would silently return zero rows for every software-encoder incident.
    it('matches a NULL-encoder (software) incident via IS NOT DISTINCT FROM', async () => {
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 'sess-sw',
            category: 'decode_error',
            encoder: null,
        });

        const sessions = await listIncidentSessions(sql, {
            category: 'decode_error',
            encoder: null,
            outcomes: ['failed'],
            limit: 10,
        });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].play_session_id).toBe('sess-sw');
    });

    // Preview/cache jobs never touch a real file — those are still real failures
    // and must not be dropped by the media_items join.
    it('includes a session whose file_id/media_id are null rather than dropping it from the join', async () => {
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 'sess-nofile',
            fileId: null,
            mediaId: null,
        });

        const sessions = await listIncidentSessions(sql, {
            category: base.category,
            encoder: base.encoder,
            outcomes: ['failed'],
            limit: 10,
        });
        const row = sessions.find((s) => s.play_session_id === 'sess-nofile');
        expect(row).toBeDefined();
        expect(row?.file_id).toBeNull();
    });

    // A chain ending on a non-terminal `retried` row (nothing recorded after it)
    // must report no terminal outcome, not error or surface the retry as terminal.
    it('reports no terminal outcome when the chain ends on a non-terminal retried row', async () => {
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 'sess-retry',
            attempt: 1,
        });
        await recordTranscodeFailureEvent(sql, {
            ...base,
            playSessionId: 'sess-retry',
            attempt: 2,
            outcome: 'retried',
        });

        const sessions = await listIncidentSessions(sql, {
            category: base.category,
            encoder: base.encoder,
            outcomes: ['failed'],
            limit: 10,
        });
        const row = sessions.find((s) => s.play_session_id === 'sess-retry');
        expect(row).toBeDefined();
        expect(row?.terminal_outcome).toBeNull();
    });

    it('prunes in bounded batches and reports how many it deleted', async () => {
        await recordTranscodeFailureEvent(sql, base);
        await sql`UPDATE transcode_failure_events SET occurred_at = NOW() - INTERVAL '60 days'`;
        const deleted = await pruneTranscodeFailureEvents(
            sql,
            new Date(Date.now() - 30 * 86_400_000),
        );
        expect(deleted).toBe(1);
    });

    it('reports the group total past the limit and filters by encoder in SQL', async () => {
        await recordTranscodeFailureEvent(sql, { ...base, category: 'gpu-failure' });
        await recordTranscodeFailureEvent(sql, { ...base, category: 'decode-error' });
        await recordTranscodeFailureEvent(sql, {
            ...base,
            category: 'decode-error',
            encoder: null,
        });

        const page = await listFailureIncidents(sql, { outcomes: ['failed'], limit: 1 });
        expect(page.rows).toHaveLength(1);
        expect(page.totalGroups).toBe(3);

        const qsv = await listFailureIncidents(sql, {
            outcomes: ['failed'],
            limit: 10,
            encoder: base.encoder,
        });
        expect(qsv.rows.map((r) => r.category).sort()).toEqual(['decode-error', 'gpu-failure']);
        expect(qsv.totalGroups).toBe(2);

        const software = await listFailureIncidents(sql, {
            outcomes: ['failed'],
            limit: 10,
            encoder: null,
        });
        expect(software.rows).toHaveLength(1);
        expect(software.rows[0].encoder).toBeNull();
    });

    it.each([
        { label: 'all incidents', category: undefined, encoder: undefined },
        { label: 'one hardware incident', category: base.category, encoder: base.encoder },
        { label: 'one software incident', category: base.category, encoder: null },
    ])(
        'clears the newest displayed event including microseconds for $label',
        async ({ category, encoder }) => {
            const eventEncoder = encoder ?? null;
            await recordTranscodeFailureEvent(sql, {
                ...base,
                encoder: eventEncoder,
                playSessionId: 'on-screen',
            });
            await recordTranscodeFailureEvent(sql, {
                ...base,
                encoder: eventEncoder,
                playSessionId: 'after-the-screen',
            });
            await recordTranscodeFailureEvent(sql, {
                ...base,
                encoder: eventEncoder,
                playSessionId: 'other-group',
                category: 'decode-error',
            });
            await recordTranscodeFailureEvent(sql, {
                ...base,
                encoder: eventEncoder,
                playSessionId: 'recovered',
                outcome: 'retried',
            });
            await recordTranscodeFailureEvent(sql, {
                ...base,
                encoder: eventEncoder === null ? base.encoder : null,
                playSessionId: 'other-encoder',
            });
            // Round-trip the API's exact text cutoff: Date/toISOString would
            // truncate it and leave the newest event behind forever.
            await sql`UPDATE transcode_failure_events SET occurred_at = '2026-10-07T10:00:00.123456Z'::timestamptz`;
            const { rows } = await listFailureIncidents(sql, { outcomes: ['failed'], limit: 10 });
            const bound = rows[0].last_seen;
            expect(bound).toBe('2026-10-07T10:00:00.123456Z');
            await sql`UPDATE transcode_failure_events
                         SET occurred_at = '2026-10-07T10:00:00.123457Z'::timestamptz
                   WHERE play_session_id = 'after-the-screen'`;

            const cleared = await deleteFailureIncidents(sql, {
                outcomes: ['failed'],
                category,
                encoder,
                before: bound,
            });
            expect(cleared).toBe(category === undefined ? 3 : 1);
            const remaining = await sql<{ play_session_id: string }[]>`
            SELECT play_session_id FROM transcode_failure_events ORDER BY play_session_id
        `;
            expect(remaining.map((row) => row.play_session_id)).toEqual(
                category === undefined
                    ? ['after-the-screen', 'recovered']
                    : ['after-the-screen', 'other-encoder', 'other-group', 'recovered'],
            );
            expect(
                await deleteFailureIncidents(sql, {
                    outcomes: ['failed'],
                    category,
                    encoder,
                    before: bound,
                }),
            ).toBe(0);
        },
    );

    it('an unbounded clear removes every failure but preserves recovered attempts', async () => {
        await recordTranscodeFailureEvent(sql, base);
        await recordTranscodeFailureEvent(sql, { ...base, outcome: 'retried' });
        expect(await deleteFailureIncidents(sql, { outcomes: ['failed'] })).toBe(1);
        const chain = await listSessionChain(sql, base.playSessionId);
        expect(chain.map((row) => row.outcome)).toEqual(['retried']);
    });
});
