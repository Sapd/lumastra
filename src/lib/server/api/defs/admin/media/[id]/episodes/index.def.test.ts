// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `GET /api/admin/media/{id}/episodes` selected `mi.premiere_date` raw and
 * typed it `string | null` on `EpisodeQueryRow`, but postgres.js registers a
 * DEFAULT parser for oids 1082/1114/1184 (date/timestamp/timestamptz) that
 * returns a native `Date` — `connection.ts` overrides only `bigint`. So the
 * field actually arrived as a `Date`, and `EpisodesResponseSchema.parse()`
 * (which the handler calls on every request) declares it
 * `z.string().nullable()`. Zod 4 rejects a Date for `z.string()`, the throw
 * escapes the handler, and mount()'s withErrorHandler turns it into a 500.
 *
 * This is the same class as the `premiere_date` bug fixed in `preview.ts`
 * (fd5cde364) and it was live for the same reason: on the production
 * catalogue 83,875 of 88,003 episodes carry a `premiere_date`, so the admin
 * episode list 500s for essentially every series.
 *
 * The suite drives the REAL handler through a `sql` mock that decides each
 * column's JS type from whether THAT call's own template text carries the
 * cast — i.e. it simulates postgres.js's behaviour for the query as written.
 * Deleting `::text` from the production SQL changes what the mock hands back,
 * so the test fails on a revert rather than on a stale fixture.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetDb = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

// The two fragment builders call `sql` themselves; stub them so the single
// `sql` call the assertions care about is the episode query and nothing else.
vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    buildAutoEpisodeOrderingJoinFragment: () => '',
    buildUnmappedEpisodeFilterFragment: () => '',
}));

const { def, EpisodesResponseSchema } = await import('./index.js');

/**
 * One `sql` template tag, driver-shaped on TWO columns:
 *
 *  - `premiere_date` comes back as a `string` only when the query text carries
 *    `premiere_date::text`; otherwise as a `Date`, which is exactly what the
 *    real driver returns for an uncast `date` column.
 *  - `chapters[].startTicks` comes back as a `string` only when the query text
 *    carries `start_ticks::text`; otherwise as a NUMBER. `episode_chapters
 *    .start_ticks` is bigint, and `json_build_object()` renders a bigint as a
 *    JSON number literal — postgres.js then hands the whole `json` column to
 *    JSON.parse(), so the bigint parser registered in connection.ts never sees
 *    it. (Even at the top level that parser yields a number, not a string, so
 *    there is no reading of this column that produces a string uncast.)
 */
function driverShapedSql() {
    return vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const text = strings.join('');
        return Promise.resolve([
            {
                id: '11111111-1111-4111-8111-111111111111',
                title: 'Pilot',
                season_number: 1,
                episode_number: 1,
                episode_number_end: null,
                overview: null,
                runtime_seconds: 2700,
                premiere_date: text.includes('premiere_date::text')
                    ? '2019-05-19'
                    : new Date('2019-05-19T00:00:00.000Z'),
                sort_order: null,
                file_path: '/data/tv/show/s01e01.mkv',
                edition: null,
                jellyfin_id: null,
                chapters: [
                    {
                        index: 0,
                        name: 'Cold Open',
                        startTicks: text.includes('start_ticks::text') ? '0' : 0,
                    },
                    {
                        index: 1,
                        name: null,
                        // 12m34.5678901s — past 2^31, so a revert cannot be
                        // mistaken for something an int column would explain.
                        startTicks: text.includes('start_ticks::text') ? '7545678901' : 7545678901,
                    },
                ],
            },
        ]);
    });
}

function makeEvent(): RequestEvent {
    return {
        locals: { resolvedIds: { internalId: '5e5e5e5e-1111-4111-8111-111111111111' } },
        params: { id: '5e5e5e5e-1111-4111-8111-111111111111' },
        url: new URL('http://localhost/api/admin/media/series-1/episodes'),
    } as unknown as RequestEvent;
}

describe('admin episodes list — premiere_date reaches a z.string() field', () => {
    it('returns 200 with a string premiere_date against the current (cast) SQL', async () => {
        mockGetDb.mockReturnValue(driverShapedSql());

        const res = await def.handlers.GET!(makeEvent(), {} as never);

        expect(res.status).toBe(200);
        const body = (await res.json()) as { episodes: { premiere_date: string | null }[] };
        // A plain YYYY-MM-DD, not an ISO instant: `date::text` renders the
        // calendar day Postgres stores, with no timezone shift applied.
        expect(body.episodes[0].premiere_date).toBe('2019-05-19');
    });

    it('emits SQL that casts premiere_date (the cast is what keeps the parse alive)', async () => {
        const sql = driverShapedSql();
        mockGetDb.mockReturnValue(sql);

        await def.handlers.GET!(makeEvent(), {} as never);

        const text = (sql.mock.calls[0][0] as TemplateStringsArray).join('');
        expect(text).toContain('premiere_date::text');
    });

    it('documents the failure mode a missing cast reproduces', () => {
        // Independent of the SQL-text detection above: a Date on this field
        // throws, because the schema declares it z.string().nullable(). This
        // is the exact throw that became a 500 for every series.
        const withDate = {
            episodes: [
                {
                    id: '11111111-1111-4111-8111-111111111111',
                    title: 'Pilot',
                    season_number: 1,
                    episode_number: 1,
                    episode_number_end: null,
                    overview: null,
                    runtime_seconds: 2700,
                    premiere_date: new Date('2019-05-19T00:00:00.000Z') as unknown as string,
                    sort_order: null,
                    file_path: '/data/tv/show/s01e01.mkv',
                    edition: null,
                    jellyfin_id: null,
                    chapters: [],
                },
            ],
        };
        expect(() => EpisodesResponseSchema.parse(withDate)).toThrow();
    });
});

describe('admin episodes list — chapter start_ticks reaches a z.string() field', () => {
    it('returns 200 with string startTicks against the current (cast) SQL', async () => {
        mockGetDb.mockReturnValue(driverShapedSql());

        const res = await def.handlers.GET!(makeEvent(), {} as never);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            episodes: { chapters: { index: number; startTicks: string }[] }[];
        };
        expect(body.episodes[0].chapters.map((c) => c.startTicks)).toEqual(['0', '7545678901']);
    });

    it('emits SQL that casts start_ticks (the cast is what keeps the parse alive)', async () => {
        const sql = driverShapedSql();
        mockGetDb.mockReturnValue(sql);

        await def.handlers.GET!(makeEvent(), {} as never);

        const text = (sql.mock.calls[0][0] as TemplateStringsArray).join('');
        expect(text).toContain('start_ticks::text');
    });

    it('documents the failure mode a missing cast reproduces', () => {
        // The observed production ZodError, reconstructed: a NUMBER on
        // chapters[].startTicks throws, because ChapterSchema declares
        // z.string(). One chaptered episode anywhere in the series takes the
        // WHOLE list down — this parse gates the entire response body.
        const withNumericTicks = {
            episodes: [
                {
                    id: '11111111-1111-4111-8111-111111111111',
                    title: 'Pilot',
                    season_number: 1,
                    episode_number: 1,
                    episode_number_end: null,
                    overview: null,
                    runtime_seconds: 2700,
                    premiere_date: '2019-05-19',
                    sort_order: null,
                    file_path: '/data/tv/show/s01e01.mkv',
                    edition: null,
                    jellyfin_id: null,
                    chapters: [{ index: 0, name: null, startTicks: 0 as unknown as string }],
                },
            ],
        };
        expect(() => EpisodesResponseSchema.parse(withNumericTicks)).toThrow();
    });
});
