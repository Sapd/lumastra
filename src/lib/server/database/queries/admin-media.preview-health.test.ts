// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getMediaPreview` — total extraction of the unvalidated `health_issues`
 * jsonb column.
 *
 * WHY THIS FILE EXISTS AT ALL. `media_files.health_issues` has TWO independent
 * producers (media-probe.ts and audio-processor.ts) and no schema between them
 * and this reader, so a shape divergence is a live possibility rather than a
 * hypothetical. Every unguarded read of that column fails the WHOLE preview
 * query or the WHOLE response parse, which means the admin inspector 500s for
 * that item permanently — not "one issue renders oddly".
 *
 * WHERE THE SEAM IS, honestly. There are two halves and they are covered
 * differently:
 *   - the SQL half (a `::float` cast that RAISES on non-numeric text; a
 *     `jsonb_array_length` that RAISES on a non-array; a NULL `type` column)
 *     can only be *executed* against a real Postgres, which lives in
 *     admin-media.queries.integration.test.ts and needs the preprod tunnel.
 *     What this file asserts about it is therefore the SHAPE of the emitted
 *     SQL — that the guards are present and admit only digits. That is a
 *     regression guard, not a proof, and it is labelled as one below.
 *   - the TypeScript half — the row array → response object mapping — is
 *     driven for real here, through the actual `getMediaPreview` with a fake
 *     `sql` tag, and its output is fed to the REAL `AdminPreviewResponseSchema`
 *     from the def. That is the parse that 500s in production, so asserting
 *     against anything else would be asserting against a copy.
 */

import { describe, it, expect } from 'vitest';
import { getMediaPreview } from './admin-media.queries.js';
import { AdminPreviewResponseSchema } from '$lib/server/api/defs/admin/media/[id]/preview.js';

type Row = Record<string, unknown>;

const BASE_ITEM: Row = {
    id: 'item-1',
    title: 'Some Movie',
    overview: null,
    year: 2020,
    media_type: 'movie',
    runtime_seconds: 5400,
    premiere_date: '2020-03-01',
    custom_metadata: null,
    metadata_locked: false,
    metadata_locked_by: null,
    metadata_locked_at: null,
    is_local_only: null,
    files_lost_at: null,
    updated_at: '2026-08-01T00:00:00.000Z',
};

interface FakeQuery extends PromiseLike<Row[]> {
    text: string;
}
interface FakeSql {
    (strings: TemplateStringsArray | string, ...values: unknown[]): FakeQuery;
    queries: string[];
}
function isFragment(value: unknown): value is FakeQuery {
    return (
        typeof value === 'object' &&
        value !== null &&
        'text' in value &&
        typeof value.text === 'string' &&
        'then' in value &&
        typeof value.then === 'function'
    );
}

/** Compose nested tags lazily, as postgres.js does; only awaited queries execute. */
function makeSql(healthRows: Row[]): FakeSql {
    const queries: string[] = [];
    const execute = (text: string): Promise<Row[]> => {
        queries.push(text);
        if (text.includes('CROSS JOIN LATERAL') && text.includes('AS expected_duration'))
            return Promise.resolve(healthRows);
        if (text.includes('custom_metadata')) return Promise.resolve([BASE_ITEM]);
        if (text.includes('FROM external_ids')) {
            return Promise.resolve([
                { tmdb_id: null, imdb_id: null, jellyfin_id: null, tvdb_id: null },
            ]);
        }
        if (text.includes('AS file_count')) {
            return Promise.resolve([
                {
                    file_count: 1,
                    total_file_size: '1000',
                    file_paths: ['/data/movies/foo.mkv'],
                    last_probed_at: null,
                },
            ]);
        }
        if (text.includes('grandparent_title')) {
            return Promise.resolve([{ parent_title: null, grandparent_title: null }]);
        }
        if (text.includes('season_number')) return Promise.resolve([]);
        if (text.includes("stream_type = 'video'")) return Promise.resolve([]);
        if (text.includes("stream_type = 'audio'")) return Promise.resolve([]);
        throw new Error(`unrouted query in test harness:\n${text}`);
    };
    const sql = ((strings: TemplateStringsArray | string, ...values: unknown[]): FakeQuery => {
        if (typeof strings === 'string')
            return {
                text: '"' + strings.replaceAll('"', '""') + '"',
                then() {
                    throw new Error('An identifier fragment is not an executable query');
                },
            };
        const text = strings.reduce(
            (result, part, index) =>
                result +
                part +
                (index < values.length
                    ? isFragment(values[index])
                        ? values[index].text
                        : '?'
                    : ''),
            '',
        );
        let execution: Promise<Row[]> | undefined;
        const query: FakeQuery = {
            text,
            then(onfulfilled, onrejected) {
                execution ??= Promise.resolve().then(() => execute(text));
                return execution.then(onfulfilled, onrejected);
            },
        };
        return query;
    }) as FakeSql;
    sql.queries = queries;
    return sql;
}

/** The exact call the def makes — this is what 500s when it throws. */
function parseAsEndpointWould(preview: unknown) {
    return AdminPreviewResponseSchema.parse({
        ...(preview as object),
        media_type: 'movie',
    });
}

describe('getMediaPreview — malformed health_issues cannot 500 the preview', () => {
    it('keeps the well-formed issues when one element has no type at all', async () => {
        // What Postgres hands back once the WHERE guard is bypassed — a driver
        // quirk, a view, or a future edit to that clause. `type` is REQUIRED by
        // AdminPreviewResponseSchema, so emitting `type: null` throws in the
        // def and the operator loses the entire panel over one bad element.
        const sql = makeSql([
            {
                type: 'truncated_video',
                detail: null,
                file_path: '/a.mkv',
                expected_duration: 7200,
                actual_duration: 5400,
            },
            {
                type: null,
                detail: 'orphan',
                file_path: '/b.mkv',
                expected_duration: null,
                actual_duration: null,
            },
            {
                type: 'corrupt_container',
                detail: 'moov atom missing',
                file_path: '/c.mkv',
                expected_duration: null,
                actual_duration: null,
            },
        ]);

        const preview = await getMediaPreview(sql as never, 'item-1');
        const parsed = parseAsEndpointWould(preview);

        expect(parsed.healthIssues?.map((h) => h.type)).toEqual([
            'truncated_video',
            'corrupt_container',
        ]);
        // The survivors must survive INTACT, not merely survive — a filter that
        // also dropped their fields would pass a length check.
        expect(parsed.healthIssues?.[0]).toMatchObject({
            type: 'truncated_video',
            filePath: '/a.mkv',
            expectedDuration: 7200,
            actualDuration: 5400,
        });
        expect(parsed.healthIssues?.[1]).toMatchObject({
            type: 'corrupt_container',
            detail: 'moov atom missing',
        });
    });

    it('drops a non-finite duration instead of failing the response parse', async () => {
        // `SELECT 'NaN'::float` and `'Infinity'::float` are both LEGAL in
        // Postgres, so a producer that wrote either string gets a number all
        // the way to Zod — where `z.number()` rejects it and the panel 500s.
        // The issue itself is still worth showing; only the duration is lost.
        const sql = makeSql([
            {
                type: 'truncated_video',
                detail: null,
                file_path: '/a.mkv',
                expected_duration: Number.NaN,
                actual_duration: Number.POSITIVE_INFINITY,
            },
            {
                type: 'audio_desync',
                detail: null,
                file_path: '/b.mkv',
                expected_duration: 120,
                actual_duration: 118.5,
            },
        ]);

        const preview = await getMediaPreview(sql as never, 'item-1');
        const parsed = parseAsEndpointWould(preview);

        expect(parsed.healthIssues).toHaveLength(2);
        expect(parsed.healthIssues?.[0]).toEqual({ type: 'truncated_video', filePath: '/a.mkv' });
        expect(parsed.healthIssues?.[0]).not.toHaveProperty('expectedDuration');
        expect(parsed.healthIssues?.[0]).not.toHaveProperty('actualDuration');
        // A fractional duration is a real value and must NOT be collateral
        // damage of the guard.
        expect(parsed.healthIssues?.[1]).toMatchObject({
            expectedDuration: 120,
            actualDuration: 118.5,
        });
    });

    it('omits healthIssues entirely when every element is malformed', async () => {
        const sql = makeSql([
            {
                type: null,
                detail: null,
                file_path: '/a.mkv',
                expected_duration: null,
                actual_duration: null,
            },
            {
                type: '',
                detail: null,
                file_path: '/b.mkv',
                expected_duration: null,
                actual_duration: null,
            },
        ]);

        const preview = await getMediaPreview(sql as never, 'item-1');
        const parsed = parseAsEndpointWould(preview);

        // `.optional()`, never `null` — an explicit `healthIssues: null` would
        // itself fail the schema, and `[]` would make the panel claim it
        // enumerated issues it did not.
        expect(parsed.healthIssues).toBeUndefined();
    });
});

describe('getMediaPreview — emitted health SQL keeps its guards', () => {
    /**
     * SHAPE assertions, not behavioural ones. Executing these guards needs a
     * real Postgres (see this file's header); what they can still catch
     * cheaply is somebody deleting or loosening a guard, which is exactly how
     * the unguarded version shipped in the first place.
     */
    async function healthQueryText(): Promise<string> {
        const sql = makeSql([]);
        await getMediaPreview(sql as never, 'item-1');
        const text = sql.queries.find(
            (q) => q.includes('CROSS JOIN LATERAL') && q.includes('AS expected_duration'),
        );
        expect(text).toBeDefined();
        return text as string;
    }

    it('guards every ::float cast with a digits-only regex test', async () => {
        const text = await healthQueryText();

        const casts = text.match(/::float/g) ?? [];
        const guards = text.match(/~ '\^-\?\[0-9\]\+\(\[\.\]\[0-9\]\+\)\?\$'/g) ?? [];

        // Two duration columns, two casts, two guards. An unguarded cast
        // added back (or a guard deleted) breaks the equality; a guard
        // rewritten to admit non-digits breaks the literal pattern above.
        expect(casts).toHaveLength(2);
        expect(guards).toHaveLength(2);
        expect(text.match(/length\([^)]*\) <= 64/g)).toHaveLength(2);
        expect(text.match(/<= 1e100::numeric/g)).toHaveLength(4);
    });

    it('projects malformed types as explicit unknown evidence instead of NULL', async () => {
        const text = await healthQueryText();
        expect(text).toContain("jsonb_typeof(he.elem->'type') = 'string'");
        expect(text).toContain("length(he.elem->>'type') BETWEEN 1 AND 80");
        expect(text).toContain(
            "THEN he.elem->>'type' ELSE 'unknown_recorded_evidence' END AS type",
        );
    });

    it('bounds array indexing inside a type guard and preserves non-array unknown evidence', async () => {
        const text = await healthQueryText();
        expect(text).not.toContain('jsonb_array_elements');
        expect(text).toMatch(
            /generate_series\(0,\s*CASE WHEN jsonb_typeof\(mf\.health_issues\) = 'array'\s*THEN LEAST\(jsonb_array_length\(mf\.health_issues\), 20\) - 1 ELSE 0 END\)/,
        );
        expect(text).toContain('AND he.ordinal <= 20');
        expect(text).toContain(
            "ELSE jsonb_build_object('type', 'unknown_recorded_evidence') END AS elem",
        );
    });
});
