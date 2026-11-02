// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `listDeliveryWindows` — the admin drawer's receiver-timed
 * delivery evidence.
 *
 * Two things can only be asserted against the EMITTED SQL, and both have bitten
 * this codebase before:
 *
 *  1. `playback_telemetry.play_session_id` is a `uuid` column while
 *     `playback_incident_events.play_session_id` is free text that can be
 *     UPPERCASE or not a uuid at all (the no-session unload beacon stores an
 *     empty string). A cast of such an id throws "invalid input syntax for type
 *     uuid" and 500s the whole detail drawer; a non-lowercased one silently
 *     matches nothing because the guard pattern is lowercase hex. The SQL `CASE`
 *     that guards the sibling incident query does NOT help here — its operand is
 *     a BOUND PARAMETER, which Postgres evaluates ahead of the CASE, so the
 *     integration test beside this file saw 22P02 raised from inside the guard.
 *     The rejection therefore happens in JS, BEFORE any query is emitted, which
 *     is what the first two tests below assert.
 *  2. The contract is "newest LAST" over the newest `limit` rows, which is a
 *     DESC+LIMIT subquery re-ordered ASC on the outside. A single
 *     `ORDER BY recorded_at ASC LIMIT 20` would return the twenty OLDEST
 *     windows of the session — the wrong rows, with no visible failure.
 */

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { listDeliveryWindows } from './delivery-windows.queries.js';
import { PLAY_SESSION_ID_UUID_PATTERN } from './playback-incident-events.queries.js';

const SESSION_ID = 'AABBCCDD-1122-3344-5566-778899AABBCC';

/** Every metadata field read as a number, i.e. every field needing the guard. */
const NUMERIC_METADATA_KEYS = [
    'bytes',
    'segments',
    'mediaSec',
    'transferMs',
    'wallMaxMs',
    'ttfbMaxMs',
    'minSegBps',
    'overdue',
    'stalls',
    'bufferAheadSec',
] as const;

/**
 * Render the query through a tagged-template stub, in the spirit of
 * `artist-merge.queries.test.ts`: the COOKED strings joined with `«value»`
 * where a parameter is interpolated, so a bound value shows up in the
 * assertions instead of vanishing into the text.
 *
 * Nested `sql` fragments (this query composes one per guarded metadata cast,
 * the way `listPlaybackIncidents` composes its WHERE clause) are INLINED into
 * the text rather than counted as values — that is what postgres.js does with
 * them, and it is the only rendering in which the regex guard is visible.
 */
const FRAGMENT = Symbol('sql-fragment');

interface StubFragment {
    [FRAGMENT]: string;
    then(resolve: (rows: unknown[]) => void): void;
}

function isFragment(value: unknown): value is StubFragment {
    return typeof value === 'object' && value !== null && FRAGMENT in value;
}

async function renderSql(
    playSessionId: string,
    limit?: number,
    rows: unknown[] = [],
): Promise<{ text: string; values: unknown[]; result: unknown[] }> {
    let text = '';
    const values: unknown[] = [];
    const stub = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
        let rendered = strings[0];
        vals.forEach((value, i) => {
            if (isFragment(value)) {
                rendered += value[FRAGMENT];
            } else {
                values.push(value);
                rendered += '«value»';
            }
            rendered += strings[i + 1];
        });
        // The OUTERMOST call runs last (its fragment arguments are evaluated
        // first), so this ends up holding the whole query.
        text = rendered;
        return {
            [FRAGMENT]: rendered,
            then: (resolve: (r: unknown[]) => void) => resolve(rows),
        } satisfies StubFragment;
    }) as unknown as postgres.Sql;

    const result =
        limit === undefined
            ? await listDeliveryWindows(stub, playSessionId)
            : await listDeliveryWindows(stub, playSessionId, limit);
    return { text, values, result };
}

describe('listDeliveryWindows — emitted SQL', () => {
    it('reads only delivery_window rows', async () => {
        const { text } = await renderSql(SESSION_ID);
        expect(text).toContain("metric_type = 'delivery_window'");
        expect(text).toContain('FROM playback_telemetry');
    });

    it('lowercases the session id and casts it once, as a bound parameter', async () => {
        const { text, values } = await renderSql(SESSION_ID);

        // The id reaches Postgres lowercased — the uuid vocabulary is lowercase hex.
        expect(values).toContain(SESSION_ID.toLowerCase());
        expect(values).not.toContain(SESSION_ID);
        expect(text).toMatch(/play_session_id = «value»::uuid/);
        // No CASE guard here on purpose: it provably did not guard anything (see
        // the header), and leaving it in would advertise protection that is not
        // there.
        expect(text).not.toContain('CASE WHEN «value»::text');
    });

    it('rejects a non-uuid id in JS, emitting NO query at all', async () => {
        // `playback_incident_events.play_session_id` is free text, so these are
        // real inputs. Reaching the database with them means 22P02 and a 500 on
        // the drawer, so the assertion is that NOTHING is sent — the empty
        // rendered text is the proof, not just an empty result.
        for (const bad of ['not-a-uuid', '', 'test-list-session-0', '   ']) {
            const { text, values, result } = await renderSql(bad);
            expect(result).toEqual([]);
            expect(text).toBe('');
            expect(values).toEqual([]);
        }

        // The JS check uses the SHARED lowercase-hex pattern from
        // playback-incident-events.queries.ts, so the two cannot disagree about
        // what a uuid is.
        expect(PLAY_SESSION_ID_UUID_PATTERN).toContain('[0-9a-f]{8}');
        expect(new RegExp(PLAY_SESSION_ID_UUID_PATTERN).test(SESSION_ID.toLowerCase())).toBe(true);
    });

    it('takes the NEWEST rows (DESC + bound LIMIT) and hands them back oldest-first', async () => {
        const { text, values } = await renderSql(SESSION_ID);

        // Inner: newest first, capped by a BOUND limit (never interpolated).
        expect(text).toMatch(/ORDER BY\s+recorded_at DESC\s+LIMIT «value»/);
        expect(values).toContain(20);
        // Outer: the final ordering the caller sees is ascending.
        expect(text.trimEnd()).toMatch(/ORDER BY\s+\w+\.recorded_at ASC$/);
    });

    it('binds a caller-supplied limit', async () => {
        const { values } = await renderSql(SESSION_ID, 5);
        expect(values).toContain(5);
        expect(values).not.toContain(20);
    });

    it('guards every numeric metadata cast behind a plain-decimal regex', async () => {
        const { text, values } = await renderSql(SESSION_ID);

        for (const key of NUMERIC_METADATA_KEYS) {
            expect(values, `${key} is not read out of metadata`).toContain(key);
        }
        // One guarded cast per numeric key — the regex admits only a plain
        // decimal, so `bytes: 'undefined'` from one buggy client build reads as
        // NULL instead of raising 22P02 and 500ing the whole drawer.
        const guards = text.match(/CASE WHEN w\.metadata->>/g) ?? [];
        expect(guards).toHaveLength(NUMERIC_METADATA_KEYS.length);
        // Written with a DOUBLED backslash in the source so Postgres receives a
        // real `\.` — a bare `.` would match ANY character and let '1x2' through.
        expect(text).toContain(String.raw`~ '^-?[0-9]+(\.[0-9]+)?$'`);
        expect(text.match(/::double precision/g) ?? []).toHaveLength(NUMERIC_METADATA_KEYS.length);
        // Every field is aliased onto the row shape the caller consumes.
        for (const key of NUMERIC_METADATA_KEYS) {
            expect(text).toContain(`as "${key}"`);
        }
        // `engine` is text — no cast to guard, just the empty-string fold.
        expect(text).toContain("NULLIF(w.metadata->>'engine', '')");
    });

    it('never casts a metadata field unguarded', async () => {
        const { text } = await renderSql(SESSION_ID);
        // A bare `NULLIF(...)::double precision` only survives the empty string;
        // 'undefined' / 'null' / '1,5' would still abort the statement. The ONE
        // NULLIF left in this query is `engine`, which is never cast.
        expect(text.match(/NULLIF\(/g) ?? []).toHaveLength(1);
        expect(text).not.toMatch(/NULLIF\([\s\S]*?\)::double precision/);
    });
});

describe('listDeliveryWindows — row mapping', () => {
    it('projects recordedAt to an ISO string and preserves row order', async () => {
        const raw = [
            {
                recordedAt: new Date('2026-09-12T10:00:00Z'),
                throughputBps: 4_000_000,
                bytes: 15_000_000,
                segments: 5,
                mediaSec: 30,
                transferMs: 28_000,
                wallMaxMs: 9_000,
                ttfbMaxMs: 400,
                minSegBps: 2_500_000,
                overdue: 0,
                stalls: 1,
                bufferAheadSec: 12.5,
                engine: 'hls_js',
            },
            {
                recordedAt: new Date('2026-09-12T10:00:30Z'),
                throughputBps: 900_000,
                bytes: null,
                segments: null,
                mediaSec: null,
                transferMs: null,
                wallMaxMs: null,
                ttfbMaxMs: null,
                minSegBps: null,
                overdue: null,
                stalls: null,
                bufferAheadSec: null,
                engine: null,
            },
        ];

        const { result } = await renderSql(SESSION_ID, undefined, raw);

        expect(result).toEqual([
            {
                recordedAt: '2026-09-12T10:00:00.000Z',
                throughputBps: 4_000_000,
                bytes: 15_000_000,
                segments: 5,
                mediaSec: 30,
                transferMs: 28_000,
                wallMaxMs: 9_000,
                ttfbMaxMs: 400,
                minSegBps: 2_500_000,
                overdue: 0,
                stalls: 1,
                bufferAheadSec: 12.5,
                engine: 'hls_js',
            },
            {
                recordedAt: '2026-09-12T10:00:30.000Z',
                throughputBps: 900_000,
                bytes: null,
                segments: null,
                mediaSec: null,
                transferMs: null,
                wallMaxMs: null,
                ttfbMaxMs: null,
                minSegBps: null,
                overdue: null,
                stalls: null,
                bufferAheadSec: null,
                engine: null,
            },
        ]);
    });
});
