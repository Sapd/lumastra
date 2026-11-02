// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Daily shows named by air date ("The Show 2021.03.14.mkv"): the real scanner
 * links them to the provider episode that aired that day, and the post-sync
 * air-date pass moves files scanned before the provider's episodes existed.
 * Real scanner, PostgreSQL and ffprobe; only provider search and lifecycle
 * enqueue are stubbed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
    closeTestDb,
    getTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { MetadataCandidate } from '../../../../../../providers/types.js';
import { listScanIssues } from '../../../../../../database/queries/media-files.queries.js';
import type { FileScannerContext } from './shared.js';
import { Logger } from '../../../../../../utils/logger.js';

const provider = vi.hoisted(() => ({
    candidates: new Map<string, MetadataCandidate>(),
    afterMatched: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => true),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async (filePath: string) => {
        const candidate = provider.candidates.get(filePath);
        if (!candidate) throw new Error(`Missing provider fixture: ${filePath}`);
        return { matched: true, candidate };
    }),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: provider.afterMatched,
        }),
    };
});

const { processVideoFile } = await import('./video-processor.js');
const { maybeRelinkByAirDate } =
    await import('../../../../../../services/air-date-reconciliation.service.js');

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';
const TITLE = 'Daily Fixture';
const SHOW_TMDB = '930001';

interface Link {
    episode_id: string;
    season_number: number;
    episode_number: number;
    title: string;
}

describe('daily-show air dates (real PG, scanner and ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let context: FileScannerContext;
    let seriesCache: Map<string, string>;
    let seasonCache: Map<string, string>;
    let announcements: Set<string>;

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger: Logger.for('DailyShowAirDateTest') };
        vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined);
    });

    afterAll(async () => closeTestDb());

    beforeEach(async () => {
        provider.candidates.clear();
        provider.afterMatched.mockClear();
        seriesCache = new Map();
        seasonCache = new Map();
        announcements = new Set();
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-daily-show-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES (${`daily-show-${Date.now()}`}) RETURNING id
        `;
        const [path] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${root}, 'tv', ${group.id}, true, 'tmdb') RETURNING *
        `;
        libraryPath = path;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${path.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function dailyFile(folder: string, name: string): Promise<string> {
        const directory = join(root, `${TITLE} (2015)`, folder);
        await mkdir(directory, { recursive: true });
        const filePath = join(directory, name);
        await copyFile(FIXTURE, filePath);
        provider.candidates.set(filePath, {
            title: TITLE,
            year: 2015,
            provider: 'tmdb',
            externalId: SHOW_TMDB,
            mediaType: 'tv',
            confidence: 1,
        });
        return filePath;
    }

    const scan = (filePath: string) =>
        processVideoFile(
            sql,
            filePath,
            libraryPath,
            [TMDB],
            context,
            undefined,
            undefined,
            undefined,
            false,
            seriesCache,
            seasonCache,
            announcements,
        );

    async function linksOf(filePath: string): Promise<Link[]> {
        return sql<Link[]>`
            SELECT ep.id AS episode_id, ep.season_number, ep.episode_number, ep.title
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items ep ON ep.id = mfi.media_item_id
            WHERE mf.file_path = ${filePath}
        `;
    }

    async function seriesId(): Promise<string> {
        const [row] = await sql<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE provider = 'tmdb' AND external_id = ${SHOW_TMDB} AND media_type = 'tv'
        `;
        return row.media_id;
    }

    /** What a TMDB series sync leaves behind: a season and identified episodes. */
    async function canonicalSeason(
        series: string,
        seasonNumber: number,
        episodes: Array<{ episode: number; airDate: string; tmdb: string; title: string }>,
    ): Promise<Map<number, string>> {
        let [season] = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${series} AND media_type = 'season' AND season_number = ${seasonNumber}
        `;
        season ??= (
            await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, parent_id, season_number)
                VALUES (${`Season ${seasonNumber}`}, 'season', 'active', ${series}, ${seasonNumber})
                RETURNING id
            `
        )[0];
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${season.id}, 'tmdb', ${String(800000 + seasonNumber)}, 'season', true, 'test-fixture')
            ON CONFLICT DO NOTHING
        `;
        const ids = new Map<number, string>();
        for (const ep of episodes) {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number, premiere_date)
                VALUES (${ep.title}, 'episode', 'active', ${season.id}, ${seasonNumber}, ${ep.episode}, ${ep.airDate}::date)
                ON CONFLICT (parent_id, season_number, episode_number)
                    WHERE media_type = 'episode' AND parent_id IS NOT NULL
                      AND season_number IS NOT NULL AND episode_number IS NOT NULL
                DO UPDATE SET title = EXCLUDED.title, premiere_date = EXCLUDED.premiere_date
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${row.id}, 'tmdb', ${ep.tmdb}, 'episode', true, 'test-fixture')
            `;
            ids.set(ep.episode, row.id);
        }
        return ids;
    }

    it('links a date-named file straight to the episode that aired that day', async () => {
        // A first file brings the series in; then the provider's episodes exist.
        const first = await dailyFile('Season 2021', `${TITLE} 2021.03.01.mkv`);
        expect(await scan(first)).not.toBe('skipped');
        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
            { episode: 41, airDate: '2021-03-15', tmdb: '7041', title: 'Guest Forty-One' },
        ]);

        const file = await dailyFile('Season 2021', `${TITLE} - 2021-03-15 - Guest.mkv`);
        await scan(file);

        expect(await linksOf(file)).toEqual([
            expect.objectContaining({
                episode_id: ids.get(41),
                season_number: 7,
                episode_number: 41,
            }),
        ]);
    });

    it('moves files scanned before the sync onto their air-date episodes', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        // No provider episodes yet: the scanner auto-numbered it in the folder season.
        const [before] = await linksOf(early);
        expect(before).toMatchObject({ season_number: 2021, episode_number: 1 });

        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);

        const result = await maybeRelinkByAirDate(sql, series);
        expect(result).toMatchObject({ relinked: 1, rowsMerged: 1, emptySeasonsDeleted: 1 });
        expect(await linksOf(early)).toEqual([
            expect.objectContaining({
                episode_id: ids.get(40),
                season_number: 7,
                episode_number: 40,
            }),
        ]);
        // The invented episode and its "Season 2021" are gone.
        const leftovers = await sql`
            SELECT 1 FROM media_items WHERE id = ${before.episode_id}
            UNION ALL
            SELECT 1 FROM media_items WHERE parent_id = ${series} AND season_number = 2021
        `;
        expect(leftovers).toHaveLength(0);
        const [episode] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE id = ${ids.get(40)!}
        `;
        expect(episode.has_files).toBe(true);

        // Nothing left to move: a second sync is a no-op.
        expect(await maybeRelinkByAirDate(sql, series)).toBeNull();
    });

    it('moves a file off a provider episode the sync adopted at its auto-number', async () => {
        // "Season 2021/…" auto-numbered to S2021E01; the provider numbers by
        // year too, so the sync bound its own S2021E01 (another day) onto that row.
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const series = await seriesId();
        const ids = await canonicalSeason(series, 2021, [
            { episode: 1, airDate: '2021-01-04', tmdb: '2101', title: 'January Guest' },
            { episode: 50, airDate: '2021-03-14', tmdb: '2150', title: 'March Guest' },
        ]);
        expect((await linksOf(early))[0].episode_id).toBe(ids.get(1));

        expect(await maybeRelinkByAirDate(sql, series)).toMatchObject({
            relinked: 1,
            rowsMerged: 0,
        });
        expect(await linksOf(early)).toEqual([
            expect.objectContaining({ episode_id: ids.get(50), episode_number: 50 }),
        ]);
        // The provider's own S2021E01 stays, now without a file.
        const [january] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE id = ${ids.get(1)!}
        `;
        expect(january.has_files).toBe(false);
    });

    it('leaves a file alone when two episodes aired that day', async () => {
        const first = await dailyFile('Season 7', `${TITLE} 2021.03.01.mkv`);
        await scan(first);
        const series = await seriesId();
        await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Early Show' },
            { episode: 41, airDate: '2021-03-14', tmdb: '7041', title: 'Late Show' },
        ]);

        const file = await dailyFile('Season 7', `${TITLE} 2021.03.14.mkv`);
        expect(await scan(file)).toBe('skipped');
        expect(await linksOf(file)).toEqual([]);
        const issues = await listScanIssues(sql);
        expect(issues.map((row) => row.file_path)).toEqual([file]);
        expect(issues[0].issues).toEqual([
            expect.objectContaining({ type: 'episode_number_unparsed' }),
        ]);
    });

    it('never moves a file off an episode an admin locked', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const [before] = await linksOf(early);
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${before.episode_id}`;
        const series = await seriesId();
        await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);

        expect(await maybeRelinkByAirDate(sql, series)).toBeNull();
        expect((await linksOf(early))[0].episode_id).toBe(before.episode_id);
    });

    it('lets the season folder pick between episodes that aired the same day', async () => {
        const first = await dailyFile('Season 7', `${TITLE} 2021.03.01.mkv`);
        await scan(first);
        const series = await seriesId();
        await canonicalSeason(series, 6, [
            { episode: 90, airDate: '2021-03-14', tmdb: '6090', title: 'Old Run Finale' },
        ]);
        const ids = await canonicalSeason(series, 7, [
            { episode: 1, airDate: '2021-03-14', tmdb: '7001', title: 'New Run Premiere' },
        ]);

        const file = await dailyFile('Season 7', `${TITLE} 2021.03.14.mkv`);
        await scan(file);
        expect(await linksOf(file)).toEqual([
            expect.objectContaining({ episode_id: ids.get(1), season_number: 7 }),
        ]);
    });

    it('records an issue instead of inventing an episode when the date is ambiguous', async () => {
        const first = await dailyFile('Season 2021', `${TITLE} 2021.03.01.mkv`);
        await scan(first);
        const series = await seriesId();
        await canonicalSeason(series, 6, [
            { episode: 90, airDate: '2021-03-14', tmdb: '6090', title: 'Old Run Finale' },
        ]);
        await canonicalSeason(series, 7, [
            { episode: 1, airDate: '2021-03-14', tmdb: '7001', title: 'New Run Premiere' },
        ]);
        const [{ count: before }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM media_items WHERE media_type = 'episode'
        `;

        // "Season 2021" names neither season, and that season has no provider
        // episodes, so before the fix this auto-numbered an invented episode.
        const file = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        expect(await scan(file)).toBe('skipped');
        expect(await linksOf(file)).toEqual([]);
        const [{ count: after }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM media_items WHERE media_type = 'episode'
        `;
        expect(after).toBe(before);
        const issues = await listScanIssues(sql);
        expect(issues.find((row) => row.file_path === file)?.issues).toEqual([
            expect.objectContaining({ type: 'episode_number_unparsed' }),
        ]);
    });

    it.each([
        ['an admin-set provider id', 'manual-id'],
        ['an identity binding', 'identity'],
    ])('never moves a file off an episode with %s', async (_label, guard) => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const [before] = await linksOf(early);
        if (guard === 'identity') {
            await sql`UPDATE media_items SET title_binding = 'identity' WHERE id = ${before.episode_id}`;
        } else {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                VALUES (${before.episode_id}, 'tmdb', '7999', 'episode', true, 'manual')
            `;
        }
        const series = await seriesId();
        await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);

        expect(await maybeRelinkByAirDate(sql, series)).toBeNull();
        expect((await linksOf(early))[0].episode_id).toBe(before.episode_id);
    });

    it('hands the default to the version that stays and keeps that row', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const [before] = await linksOf(early);
        // A second, non-date file the admin attached to the same row.
        const [other] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${join(root, 'other-version.mkv')}) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${other.id}, ${before.episode_id}, false, 1)
        `;
        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);

        expect(await maybeRelinkByAirDate(sql, series)).toMatchObject({
            relinked: 1,
            rowsMerged: 0,
        });
        expect(await linksOf(early)).toEqual([
            expect.objectContaining({ episode_id: ids.get(40) }),
        ]);
        const remaining = await sql<{ file_id: string; is_default: boolean }[]>`
            SELECT file_id, is_default FROM media_file_items WHERE media_item_id = ${before.episode_id}
        `;
        expect(remaining).toEqual([{ file_id: other.id, is_default: true }]);
    });

    it('carries watch state from the invented episode to the real one', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const [before] = await linksOf(early);
        const userId = randomUUID();
        await sql`INSERT INTO users (id, username) VALUES (${userId}, ${`daily-${userId}`})`;
        try {
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms)
                VALUES (${userId}, ${before.episode_id}, true, 1234)
            `;
            const series = await seriesId();
            const ids = await canonicalSeason(series, 7, [
                { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
            ]);

            expect(await maybeRelinkByAirDate(sql, series)).toMatchObject({ rowsMerged: 1 });
            const state = await sql<{ media_id: string; is_watched: boolean }[]>`
                SELECT media_id, is_watched FROM user_media_state WHERE user_id = ${userId}
            `;
            expect(state).toEqual([{ media_id: ids.get(40), is_watched: true }]);
        } finally {
            await sql`DELETE FROM user_media_state WHERE user_id = ${userId}`;
            await sql`DELETE FROM users WHERE id = ${userId}`;
        }
    });

    it('leaves a file that spans several episodes alone', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const [before] = await linksOf(early);
        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
            { episode: 41, airDate: '2021-03-15', tmdb: '7041', title: 'Guest Forty-One' },
        ]);
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            SELECT mf.id, ${ids.get(41)!}, true FROM media_files mf WHERE mf.file_path = ${early}
        `;

        expect(await maybeRelinkByAirDate(sql, series)).toBeNull();
        expect((await linksOf(early)).map((l) => l.episode_id).sort()).toEqual(
            [before.episode_id, ids.get(41)].sort(),
        );
    });

    it('keeps a file on its episode when TMDB shifts the run by a day', async () => {
        const first = await dailyFile('Season 2021', `${TITLE} 2021.03.01.mkv`);
        await scan(first);
        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 39, airDate: '2021-03-13', tmdb: '7039', title: 'Guest Thirty-Nine' },
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);
        const file = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(file);
        expect((await linksOf(file))[0].episode_id).toBe(ids.get(40));

        // A later sync lists the whole run one day later.
        await sql`UPDATE media_items SET premiere_date = '2021-03-14' WHERE id = ${ids.get(39)!}`;
        await sql`UPDATE media_items SET premiere_date = '2021-03-15' WHERE id = ${ids.get(40)!}`;

        const result = await maybeRelinkByAirDate(sql, series);
        expect(result?.relinked ?? 0).toBe(0);
        expect((await linksOf(file))[0].episode_id).toBe(ids.get(40));
    });

    it('records an issue instead of inventing an episode for a day TMDB does not list yet', async () => {
        const first = await dailyFile('Season 2021', `${TITLE} 2021.03.01.mkv`);
        await scan(first);
        const series = await seriesId();
        await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);
        const [{ count: before }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM media_items WHERE media_type = 'episode'
        `;

        // "Season 2021" holds no provider episodes, so the season-level guard
        // alone would have auto-numbered this into an invented S2021E02.
        const file = await dailyFile('Season 2021', `${TITLE} 2021.04.01.mkv`);
        expect(await scan(file)).toBe('skipped');
        expect(await linksOf(file)).toEqual([]);
        const [{ count: after }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM media_items WHERE media_type = 'episode'
        `;
        expect(after).toBe(before);
        const issues = await listScanIssues(sql);
        expect(issues.find((row) => row.file_path === file)?.issues).toEqual([
            expect.objectContaining({ type: 'episode_number_unparsed' }),
        ]);
    });

    it('stamps library_added_at on the episode a file moves to', async () => {
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const series = await seriesId();
        const ids = await canonicalSeason(series, 7, [
            { episode: 40, airDate: '2021-03-14', tmdb: '7040', title: 'Guest Forty' },
        ]);

        await maybeRelinkByAirDate(sql, series);
        const [row] = await sql<{ library_added_at: Date | null }[]>`
            SELECT library_added_at FROM media_items WHERE id = ${ids.get(40)!}
        `;
        expect(row.library_added_at).not.toBeNull();
    });

    it('moves watch state off a provider episode the file leaves', async () => {
        // The adopted-position case: the file sat on the provider's S2021E01
        // (another day) and was watched there before the pass moved it.
        const early = await dailyFile('Season 2021', `${TITLE} 2021.03.14.mkv`);
        await scan(early);
        const series = await seriesId();
        const ids = await canonicalSeason(series, 2021, [
            { episode: 1, airDate: '2021-01-04', tmdb: '2101', title: 'January Guest' },
            { episode: 50, airDate: '2021-03-14', tmdb: '2150', title: 'March Guest' },
        ]);
        const january = ids.get(1)!;
        const march = ids.get(50)!;
        const viewer = randomUUID();
        const both = randomUUID(); // already has state on the target too
        for (const id of [viewer, both]) {
            await sql`INSERT INTO users (id, username) VALUES (${id}, ${`daily-${id}`})`;
        }
        try {
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms)
                VALUES (${viewer}, ${january}, true, 1000),
                       (${both}, ${january}, true, 2000),
                       (${both}, ${march}, false, 3000)
            `;
            await sql`
                INSERT INTO user_media_events (user_id, media_id, event_type, source, occurred_at)
                VALUES (${viewer}, ${january}, 'completed', 'lumastra-player', now())
            `;

            const result = await maybeRelinkByAirDate(sql, series);
            expect(result).toMatchObject({ relinked: 1, watchStateUsersMoved: 1 });

            const state = await sql<
                { user_id: string; media_id: string; resume_position_ms: string }[]
            >`
                SELECT user_id, media_id, resume_position_ms::text
                FROM user_media_state WHERE user_id = ANY(${[viewer, both]}::uuid[])
                ORDER BY user_id, media_id
            `;
            expect(state).toEqual(
                expect.arrayContaining([
                    { user_id: viewer, media_id: march, resume_position_ms: '1000' },
                    // A user with state on both keeps each where it was.
                    { user_id: both, media_id: january, resume_position_ms: '2000' },
                    { user_id: both, media_id: march, resume_position_ms: '3000' },
                ]),
            );
            expect(state).toHaveLength(3);
            const events = await sql<{ media_id: string }[]>`
                SELECT media_id FROM user_media_events WHERE user_id = ${viewer}
            `;
            expect(events).toEqual([{ media_id: march }]);
        } finally {
            await sql`DELETE FROM user_media_events WHERE user_id = ANY(${[viewer, both]}::uuid[])`;
            await sql`DELETE FROM user_media_state WHERE user_id = ANY(${[viewer, both]}::uuid[])`;
            await sql`DELETE FROM users WHERE id = ANY(${[viewer, both]}::uuid[])`;
        }
    });
});
