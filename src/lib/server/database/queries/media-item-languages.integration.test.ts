// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for migration 16.148.0: the normalize_track_language()
 * SQL function and the media_item_languages projection table shape.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    refreshItemLanguages,
    refreshSeriesLanguages,
    refreshLanguagesForFile,
    rebuildAllLanguages,
    convergeSidecarLanguagesByPrefix,
} from './media-item-languages.queries.js';

describe('normalize_track_language', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    it('maps in-set codes to normalized 2-letter, out-of-set to other, unknown to null', async () => {
        const rows = await sql<{ input: string | null; out: string | null }[]>`
            SELECT c AS input, normalize_track_language(c) AS out
            FROM (VALUES ('ger'),('deu'),('eng'),('ENG'),('jpn'),('kor'),
                         ('rus'),('fre'),('und'),('') ) AS v(c)`;
        const map = Object.fromEntries(rows.map((r) => [r.input, r.out]));
        expect(map).toMatchObject({
            ger: 'de',
            deu: 'de',
            eng: 'en',
            ENG: 'en',
            jpn: 'ja',
            kor: 'ko',
            rus: 'other',
            fre: 'other',
            und: null,
            '': null,
        });
        // NULL input → NULL output
        const [nullRow] = await sql<{ out: string | null }[]>`
            SELECT normalize_track_language(NULL) AS out`;
        expect(nullRow.out).toBeNull();
    });

    it('created the projection table with the expected shape', async () => {
        const cols = await sql<{ column_name: string }[]>`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'media_item_languages' ORDER BY column_name`;
        expect(cols.map((c) => c.column_name)).toEqual(['kind', 'language', 'media_item_id']);
    });
});

// Minimal fixture helper — inserts a movie with one media_file and streams for
// the given audio/subtitle languages.
async function seedMovieWithStreams(
    sql: postgres.Sql,
    langs: { audio: (string | null)[]; subtitle: (string | null)[] },
): Promise<string> {
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, status, has_files)
        VALUES ('movie', 'Fixture Movie', 'active', true) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path) VALUES ('/fixtures/movie.mkv') RETURNING id`;
    await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${item.id}, ${file.id})`;
    let idx = 0;
    for (const l of langs.audio) {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                  VALUES (${file.id}, 'audio', ${idx++}, ${l})`;
    }
    for (const l of langs.subtitle) {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                  VALUES (${file.id}, 'subtitle', ${idx++}, ${l})`;
    }
    return item.id;
}

describe('refreshItemLanguages', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('stores normalized audio+subtitle langs, other for out-of-set, drops und/null', async () => {
        const id = await seedMovieWithStreams(sql, {
            audio: ['eng', 'ger', 'rus', 'und', null],
            subtitle: ['eng'],
        });
        await refreshItemLanguages(sql, id);
        const rows = await sql<{ kind: string; language: string }[]>`
            SELECT kind, language FROM media_item_languages
            WHERE media_item_id = ${id} ORDER BY kind, language`;
        expect(rows).toEqual([
            { kind: 'audio', language: 'de' },
            { kind: 'audio', language: 'en' },
            { kind: 'audio', language: 'other' },
            { kind: 'subtitle', language: 'en' },
        ]);
    });

    it('is idempotent and reflects removed streams on re-run', async () => {
        const id = await seedMovieWithStreams(sql, { audio: ['eng'], subtitle: [] });
        await refreshItemLanguages(sql, id);
        await sql`DELETE FROM media_streams WHERE file_id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${id})`;
        await refreshItemLanguages(sql, id);
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM media_item_languages WHERE media_item_id = ${id}`;
        expect(count).toBe('0');
    });
});

let episodeFixtureCounter = 0;

async function seedEpisode(sql: postgres.Sql, parentId: string, audio: string[]): Promise<string> {
    const [ep] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, status, has_files, parent_id)
        VALUES ('episode', 'Ep', 'active', true, ${parentId}) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path) VALUES (${`/fixtures/ep-${episodeFixtureCounter++}.mkv`}) RETURNING id`;
    await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${ep.id}, ${file.id})`;
    let idx = 0;
    for (const l of audio) {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                  VALUES (${file.id}, 'audio', ${idx++}, ${l})`;
    }
    await refreshItemLanguages(sql, ep.id);
    return ep.id;
}

describe('refreshSeriesLanguages', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('keeps only languages present in a strict majority of episodes with data', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Fixture Series', 'active', true) RETURNING id`;
        // 3 episodes: de in 2/3 (majority), en in 1/3 (not)
        await seedEpisode(sql, series.id, ['ger']);
        await seedEpisode(sql, series.id, ['ger']);
        await seedEpisode(sql, series.id, ['eng']);
        await refreshSeriesLanguages(sql, series.id);
        const rows = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages
            WHERE media_item_id = ${series.id} AND kind = 'audio' ORDER BY language`;
        expect(rows.map((r) => r.language)).toEqual(['de']);
    });

    it('counts season-nested episodes via COALESCE(grandparent, parent)', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Nested Series', 'active', true) RETURNING id`;
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES ('season', 'S1', 'active', true, ${series.id}) RETURNING id`;
        await seedEpisode(sql, season.id, ['jpn']);
        await seedEpisode(sql, season.id, ['jpn']);
        await refreshSeriesLanguages(sql, series.id);
        const rows = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages
            WHERE media_item_id = ${series.id} AND kind = 'audio'`;
        expect(rows.map((r) => r.language)).toEqual(['ja']);
    });
});

describe('refreshLanguagesForFile', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('refreshes the episode item and rolls up its series', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Hook Series', 'active', true) RETURNING id`;
        const [ep] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES ('episode', 'Ep', 'active', true, ${series.id}) RETURNING id`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/fixtures/hook.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${ep.id}, ${file.id})`;
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                  VALUES (${file.id}, 'audio', 0, 'kor')`;

        await refreshLanguagesForFile(sql, file.id);

        const epRows = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages WHERE media_item_id = ${ep.id} AND kind='audio'`;
        const seriesRows = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages WHERE media_item_id = ${series.id} AND kind='audio'`;
        expect(epRows.map((r) => r.language)).toEqual(['ko']);
        expect(seriesRows.map((r) => r.language)).toEqual(['ko']); // 1/1 episodes → majority
    });

    it('picks up external subtitle sidecars (normalized)', async () => {
        const [item] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Sidecar Movie', 'active', true) RETURNING id`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/fixtures/sidecar.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${item.id}, ${file.id})`;
        // No media_streams seeded — this is an already-probed file that gets a
        // sidecar subtitle added later, the scenario refreshLanguagesForFile
        // must pick up via the external_subtitle_files UNION branch.
        await sql`
            INSERT INTO external_subtitle_files (file_id, subtitle_path, language, format)
            VALUES (${file.id}, '/fixtures/sidecar.ger.srt', 'ger', 'srt')`;

        await refreshLanguagesForFile(sql, file.id);

        const rows = await sql<{ kind: string; language: string }[]>`
            SELECT kind, language FROM media_item_languages
            WHERE media_item_id = ${item.id} ORDER BY kind, language`;
        expect(rows).toEqual([{ kind: 'subtitle', language: 'de' }]);
    });
});

let rebuildFixtureCounter = 0;

describe('rebuildAllLanguages', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('backfills item and series rows from existing streams in one pass', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Backfill Series', 'active', true) RETURNING id`;
        const mk = async (audio: string): Promise<void> => {
            const [ep] = await sql<{ id: string }[]>`
                INSERT INTO media_items (media_type, title, status, has_files, parent_id)
                VALUES ('episode','Ep','active',true,${series.id}) RETURNING id`;
            const [f] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path)
                VALUES (${`/fixtures/bf-${rebuildFixtureCounter++}.mkv`}) RETURNING id`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${ep.id}, ${f.id})`;
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                      VALUES (${f.id}, 'audio', 0, ${audio})`;
        };
        await mk('eng');
        await mk('eng');
        // No refresh called — rows absent until rebuild:
        await rebuildAllLanguages(sql);
        const seriesRows = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages WHERE media_item_id = ${series.id} AND kind='audio'`;
        expect(seriesRows.map((r) => r.language)).toEqual(['en']);
    });
});

/**
 * The delta write, and the burden it carries.
 *
 * `refreshItemLanguages` / `refreshSeriesLanguages` used to DELETE every row for
 * the item and re-INSERT the answer. That cannot be wrong, and it cost 24.8M
 * inserts and 24.8M deletes against a 37,620-row table on production — 64% of
 * the table rewritten inside one scan cycle. They now write only the difference,
 * which CAN be wrong, so these tests carry two obligations:
 *
 *   1. the steady state writes NOTHING — asserted by ctid, because a stable ctid
 *      is proof no tuple version was written where an equal row set is not;
 *   2. the projection still converges from ARBITRARY drift, which is the healing
 *      property the old form got for free.
 */
describe('language projection — delta write', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function langRows(id: string): Promise<{ kind: string; language: string }[]> {
        return sql<{ kind: string; language: string }[]>`
            SELECT kind, language FROM media_item_languages
            WHERE media_item_id = ${id} ORDER BY kind, language`;
    }

    async function ctids(id: string): Promise<string[]> {
        const rows = await sql<{ ctid: string }[]>`
            SELECT ctid::text FROM media_item_languages
            WHERE media_item_id = ${id} ORDER BY kind, language`;
        return rows.map((r) => r.ctid);
    }

    it('writes no tuple at all when the projection already matches', async () => {
        const id = await seedMovieWithStreams(sql, {
            audio: ['eng', 'ger'],
            subtitle: ['eng'],
        });
        await refreshItemLanguages(sql, id);
        const before = await ctids(id);
        expect(before).toHaveLength(3);

        await refreshItemLanguages(sql, id);
        await refreshItemLanguages(sql, id);

        // Every heap update writes a new tuple version at a new ctid, HOT or
        // not. Unchanged ctids across two further runs is the amplification
        // finding closed, measured rather than inferred.
        expect(await ctids(id)).toEqual(before);
    });

    it('touches only the rows that actually changed', async () => {
        const id = await seedMovieWithStreams(sql, { audio: ['eng', 'ger'], subtitle: [] });
        await refreshItemLanguages(sql, id);
        const [enCtid] = await sql<{ ctid: string }[]>`
            SELECT ctid::text FROM media_item_languages
            WHERE media_item_id = ${id} AND kind = 'audio' AND language = 'en'`;

        // Drop German, add Japanese: 'en' is in both the old and new answer and
        // must be left physically alone.
        await sql`DELETE FROM media_streams WHERE file_id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${id})
            AND language = 'ger'`;
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
            SELECT file_id, 'audio', 99, 'jpn' FROM media_file_items WHERE media_item_id = ${id}`;
        await refreshItemLanguages(sql, id);

        expect(await langRows(id)).toEqual([
            { kind: 'audio', language: 'en' },
            { kind: 'audio', language: 'ja' },
        ]);
        const [enAfter] = await sql<{ ctid: string }[]>`
            SELECT ctid::text FROM media_item_languages
            WHERE media_item_id = ${id} AND kind = 'audio' AND language = 'en'`;
        expect(enAfter.ctid).toBe(enCtid.ctid);
    });

    /**
     * The healing obligation, stated as bluntly as it can be: whatever junk is
     * in the table, one call converges it. Delete-then-insert got this for free;
     * a delta has to earn it.
     */
    it('converges from arbitrary drift in a single call', async () => {
        const id = await seedMovieWithStreams(sql, { audio: ['eng'], subtitle: ['ger'] });
        await refreshItemLanguages(sql, id);

        // Wreck it three ways at once: a row that should be gone, a row of the
        // wrong kind, and a missing row that should be there.
        await sql`DELETE FROM media_item_languages
                  WHERE media_item_id = ${id} AND kind = 'subtitle'`;
        await sql`INSERT INTO media_item_languages (media_item_id, kind, language)
                  VALUES (${id}, 'audio', 'ja'), (${id}, 'subtitle', 'other')`;

        await refreshItemLanguages(sql, id);

        expect(await langRows(id)).toEqual([
            { kind: 'audio', language: 'en' },
            { kind: 'subtitle', language: 'de' },
        ]);
    });

    it('empties the projection when the last recognisable track goes', async () => {
        // The case a NOT EXISTS delta gets wrong if it is written to skip the
        // delete when the desired set is empty: every row must go.
        const id = await seedMovieWithStreams(sql, { audio: ['eng'], subtitle: ['ger'] });
        await refreshItemLanguages(sql, id);
        expect(await langRows(id)).toHaveLength(2);

        await sql`UPDATE media_streams SET language = 'und' WHERE file_id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${id})`;
        await refreshItemLanguages(sql, id);

        expect(await langRows(id)).toEqual([]);
    });

    it('leaves the series rollup physically untouched when the majority has not moved', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Steady Series', 'active', true) RETURNING id`;
        await seedEpisode(sql, series.id, ['ger']);
        await seedEpisode(sql, series.id, ['ger']);
        await refreshSeriesLanguages(sql, series.id);
        const before = await ctids(series.id);
        expect(before).toHaveLength(1);

        // This is the call that ran ~5,781 times per cycle on /data/series.
        await refreshSeriesLanguages(sql, series.id);
        await refreshSeriesLanguages(sql, series.id);

        expect(await ctids(series.id)).toEqual(before);
    });

    it('still re-derives the series majority when an episode changes it', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Shifting Series', 'active', true) RETURNING id`;
        const ep1 = await seedEpisode(sql, series.id, ['ger']);
        const ep2 = await seedEpisode(sql, series.id, ['ger']);
        await seedEpisode(sql, series.id, ['ger']);
        await refreshSeriesLanguages(sql, series.id);
        expect(await langRows(series.id)).toEqual([{ kind: 'audio', language: 'de' }]);

        // Two of the three episodes become Japanese-only, so the majority flips.
        // Both halves of the delta have to fire: 'de' deleted, 'ja' inserted.
        await sql`UPDATE media_streams SET language = 'jpn' WHERE file_id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id IN (${ep1}, ${ep2}))`;
        await refreshItemLanguages(sql, ep1);
        await refreshItemLanguages(sql, ep2);
        await refreshSeriesLanguages(sql, series.id);

        expect(await langRows(series.id)).toEqual([{ kind: 'audio', language: 'ja' }]);
    });

    it('drops the series rollup entirely when no language holds a majority', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('tv', 'Split Series', 'active', true) RETURNING id`;
        await seedEpisode(sql, series.id, ['ger']);
        await seedEpisode(sql, series.id, ['ger']);
        await refreshSeriesLanguages(sql, series.id);
        expect(await langRows(series.id)).toEqual([{ kind: 'audio', language: 'de' }]);

        // Add two English episodes: 2/4 is not a strict majority for either, so
        // the desired set becomes EMPTY and the stale row must still be removed.
        await seedEpisode(sql, series.id, ['eng']);
        await seedEpisode(sql, series.id, ['eng']);
        await refreshSeriesLanguages(sql, series.id);

        expect(await langRows(series.id)).toEqual([]);
    });
});

describe('convergeSidecarLanguagesByPrefix — same post-state as a per-sidecar refreshLanguagesForFile', () => {
    // The scanner used to call refreshLanguagesForFile once per sidecar (plus
    // nothing for a file a sidecar moved away from). The set-based pass must
    // land on the identical projection, from an identical — deliberately
    // drifted — starting state, and must not touch items outside the prefix.
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    interface Fixture {
        sidecarFileIds: string[];
        orphanFileId: string;
        outsideItemId: string;
    }

    async function item(type: string, parentId: string | null): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES (${type}, ${type}, 'active', true, ${parentId}) RETURNING id`;
        return row.id;
    }
    async function file(itemId: string, filePath: string, audio: string[]): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${filePath}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${itemId}, ${row.id})`;
        let idx = 0;
        for (const l of audio) {
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language)
                      VALUES (${row.id}, 'audio', ${idx++}, ${l})`;
        }
        return row.id;
    }
    async function sidecar(fileId: string, subtitlePath: string, lang: string | null) {
        await sql`INSERT INTO external_subtitle_files (file_id, subtitle_path, language, format)
                  VALUES (${fileId}, ${subtitlePath}, ${lang}, 'srt')`;
    }

    async function seed(): Promise<Fixture> {
        const LIB = '/lib/series';
        const series = await item('tv', null);
        const season = await item('season', series);
        const ep1 = await item('episode', season);
        const ep2 = await item('episode', season);
        const ep3 = await item('episode', season);
        const f1 = await file(ep1, `${LIB}/Show/S01/e1.mkv`, ['jpn']);
        const f2 = await file(ep2, `${LIB}/Show/S01/e2.mkv`, ['jpn']);
        // e3 once owned a German sidecar, re-paired away: its projection row is stale.
        const f3 = await file(ep3, `${LIB}/Show/S01/e3.mkv`, ['jpn']);
        await sidecar(f1, `${LIB}/Show/S01/e1.en.srt`, 'eng');
        await sidecar(f1, `${LIB}/Show/S01/e1.de.srt`, 'ger');
        await sidecar(f2, `${LIB}/Show/S01/e2.en.srt`, 'eng');
        await sidecar(f2, `${LIB}/Show/S01/e2.und.srt`, null);
        const movie = await item('movie', null);
        const fm = await file(movie, `${LIB}/Film/film.mkv`, ['eng']);
        await sidecar(fm, `${LIB}/Film/film.ko.srt`, 'kor');
        // Outside the prefix (sibling path that shares the string prefix).
        const outside = await item('movie', null);
        const fo = await file(outside, '/lib/series-other/x.mkv', ['eng']);
        await sidecar(fo, '/lib/series-other/x.en.srt', 'eng');

        // Drift: stale + missing rows everywhere, including the series rollup
        // and the out-of-prefix item (which must stay exactly as it is).
        await sql`INSERT INTO media_item_languages (media_item_id, kind, language) VALUES
            (${ep1}, 'subtitle', 'other'),
            (${ep3}, 'subtitle', 'de'),
            (${series}, 'subtitle', 'ko'),
            (${outside}, 'subtitle', 'ja')`;
        return { sidecarFileIds: [f1, f1, f2, f2, fm], orphanFileId: f3, outsideItemId: outside };
    }

    async function snapshot(): Promise<string[]> {
        const rows = await sql<{ k: string }[]>`
            SELECT mi.media_type || ':' || mi.title || ':' || mil.media_item_id || ':' || mil.kind || ':' || mil.language AS k
            FROM media_item_languages mil JOIN media_items mi ON mi.id = mil.media_item_id
            ORDER BY 1`;
        return rows.map((r) => r.k);
    }

    it('matches the per-sidecar refresh exactly and leaves out-of-prefix items alone', async () => {
        const fx = await seed();
        const drifted = await snapshot();
        const [{ ids }] = await sql<{ ids: string[] }[]>`
            SELECT array_agg(media_item_id) AS ids FROM media_item_languages`;

        // Reference: the old scanner path, plus the orphaned file it USED to miss.
        for (const fileId of fx.sidecarFileIds) await refreshLanguagesForFile(sql, fileId);
        await refreshLanguagesForFile(sql, fx.orphanFileId);
        const expected = await snapshot();
        expect(expected).not.toEqual(drifted);

        // Restore the identical drifted state, then run the set-based pass.
        await sql`DELETE FROM media_item_languages`;
        for (const k of drifted) {
            const [, , id, kind, language] = k.split(':');
            await sql`INSERT INTO media_item_languages (media_item_id, kind, language)
                      VALUES (${id}, ${kind}, ${language})`;
        }
        expect(await snapshot()).toEqual(drifted);
        expect(ids.length).toBeGreaterThan(0);

        const result = await convergeSidecarLanguagesByPrefix(sql, '/lib/series', [
            fx.orphanFileId,
        ]);
        expect(await snapshot()).toEqual(expected);
        // 3 episodes + 1 movie converged; one series rebuilt once.
        expect(result).toEqual({ items: 4, series: 1 });

        const outside = await sql<{ language: string }[]>`
            SELECT language FROM media_item_languages WHERE media_item_id = ${fx.outsideItemId}`;
        expect(outside.map((r) => r.language)).toEqual(['ja']);
    });

    it('is a no-op when the prefix owns no sidecars', async () => {
        await expect(convergeSidecarLanguagesByPrefix(sql, '/nothing/here')).resolves.toEqual({
            items: 0,
            series: 0,
        });
    });
});
