// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import * as config from '$lib/server/config.js';
import { getAlbums, getGenreCoverAlbums, getDistinctMusicGenres } from './music.queries.js';
import { searchMusic } from './search.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';
import { findTrackFileForAlbum } from './album-art.queries.js';
import {
    attachFileToItem,
    markFileMissing,
    upsertMediaFile,
    deleteStaleMediaFile,
} from './media-files.queries.js';
import { safeAccess, safeReaddir } from '$lib/server/utils/safe-fs.js';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    evaluateRetentionUnits,
    findRetentionRootGroups,
    getLibraryGroupScanEvidence,
    type RetentionUnitCandidate,
} from './media-retention.queries.js';
import {
    backfillHasFilesMediaItems,
    clearStaleHasFilesMediaItems,
    findHardDeletableMediaIds,
    isHardDeletableMediaId,
} from './database-cleanup.queries.js';
import { deleteEmptyAlbum } from './artist-merge.queries.js';
import { setAudiobookFlags } from './audiobooks.queries.js';
import { insertComment, upsertReaction } from './interactions.queries.js';
import { setFlag } from './user-media-flags.queries.js';
import type { UserId } from '$lib/shared/user-id';

vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { afterDeletedBatch: vi.fn(), afterDismissed: vi.fn() },
}));
const healthyEntries = [{ name: 'Library', isFile: () => false, isDirectory: () => true }];
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeAccess: vi.fn().mockResolvedValue(undefined),
    safeStat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    safeReaddir: vi.fn(),
}));
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { insertScannerRun } from './file-scanner-runs.queries.js';
import {
    runMediaRetention,
    lockRetentionUnit,
} from '$lib/server/services/media-retention.service.js';
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { registerTask: vi.fn() } }));
import { unavailableMediaRetentionTask } from '$lib/server/tasks/builtin/native/unavailable-media-retention.js';

type PathKind = 'music' | 'movie' | 'tv' | 'anime';
interface Group {
    group: string;
    path: string;
    dir: string;
}
interface Fx {
    sql: postgres.Sql;
    user: string;
    g: Record<'music' | 'movie' | 'tv', Group>;
}

const rollback = new Error('rollback test fixtures');
let db: postgres.Sql;

const SCAN_OK = {
    success: true,
    itemsProcessed: 10,
    result: { scanErrors: 0, added: 0, updated: 0, skipped: 10, unmatched: 0 },
};

interface PathOpts {
    enabled?: boolean;
    scan?: Record<string, unknown> | null;
    state?: string;
    completedAgo?: string;
}

async function addGroup(
    sql: postgres.Sql,
    mediaType: PathKind,
    opts: PathOpts = {},
): Promise<Group> {
    const group = crypto.randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
    return { group, ...(await addPath(sql, group, mediaType, opts)) };
}

/** One more scanned path in an existing library group. */
async function addPath(
    sql: postgres.Sql,
    group: string,
    mediaType: PathKind,
    opts: PathOpts = {},
): Promise<{ path: string; dir: string }> {
    const path = crypto.randomUUID(),
        dir = `/lib/${path}`;
    await sql`INSERT INTO library_paths (id, path, media_type, provider, library_group_id, enabled, updated_at)
        VALUES (${path}, ${dir}, ${mediaType}, ${mediaType === 'music' ? 'musicbrainz' : 'tmdb'},
                ${group}, ${opts.enabled ?? true}, NOW() - INTERVAL '2 hours')`;
    if (opts.scan !== null)
        await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, result)
            VALUES (${crypto.randomUUID()}, 'file-library-scan', 'test scan', ${opts.state ?? 'completed'},
                    ${sql.json({ libraryPathId: path })}, '{}'::jsonb, '{}'::jsonb, '1',
                    NOW() - INTERVAL '1 hour' - ${opts.completedAgo ?? '0 seconds'}::interval,
                    NOW() - ${opts.completedAgo ?? '0 seconds'}::interval,
                    ${sql.json((opts.scan ?? SCAN_OK) as postgres.JSONValue)})`;
    return { path, dir };
}

async function inFixture(
    fn: (fx: Fx) => Promise<void>,
    deadline?: LocalTestDeadline,
): Promise<void> {
    try {
        await db.begin(async (raw) => {
            const sql = deadline
                ? deadlineAwareSql(raw as unknown as postgres.Sql, deadline)
                : (raw as unknown as postgres.Sql);
            const user = crypto.randomUUID();
            await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
            await sql`INSERT INTO user_profiles (user_id) VALUES (${user})`;
            const g = {
                music: await addGroup(sql, 'music'),
                movie: await addGroup(sql, 'movie'),
                tv: await addGroup(sql, 'tv'),
            };
            await fn({ sql, user, g });
            deadline?.assertRemaining();
            throw rollback;
        });
    } catch (error) {
        if (error !== rollback) throw error;
    }
}

interface LocalTestDeadline {
    signal: AbortSignal;
    expired: () => boolean;
    remainingMs: () => number;
    assertRemaining: () => void;
    awaitQuery: <T>(pending: PromiseLike<T> & { cancel?: () => void }, label: string) => Promise<T>;
    dispose: () => void;
}

/** One absolute budget covers fixture writes plus evaluation and leaves time for rollback. */
function createLocalTestDeadline(budgetMs: number, label: string): LocalTestDeadline {
    const controller = new AbortController();
    const startedAt = Date.now();
    let expired = false;
    const timer = setTimeout(() => {
        expired = true;
        controller.abort(new Error(`${label} exceeded its ${budgetMs}ms local budget`));
    }, budgetMs);
    return {
        signal: controller.signal,
        expired: () => expired,
        remainingMs: () => Math.max(1, budgetMs - (Date.now() - startedAt)),
        assertRemaining: () => controller.signal.throwIfAborted(),
        awaitQuery: async <T>(
            pending: PromiseLike<T> & { cancel?: () => void },
            queryLabel: string,
        ) => {
            const cancel = (): void => pending.cancel?.();
            if (controller.signal.aborted) cancel();
            else controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                return await pending;
            } catch (error) {
                if (expired)
                    throw new Error(
                        `${queryLabel} exceeded its ${budgetMs}ms local budget; cancellation was awaited`,
                        { cause: error },
                    );
                throw error;
            } finally {
                controller.signal.removeEventListener('abort', cancel);
            }
        },
        dispose: () => clearTimeout(timer),
    };
}

/** Wrap every SQL tag invocation, including nested service transactions, in the same budget. */
function deadlineAwareSql(sql: postgres.Sql, deadline: LocalTestDeadline): postgres.Sql {
    return new Proxy(sql, {
        apply(target, _thisArg, args) {
            const query = Reflect.apply(target, target, args) as PromiseLike<unknown> & {
                cancel?: () => void;
            };
            // Keep Query instances intact for postgres.js nested SQL fragments.
            // Only a consumer awaiting the query enters the cancellable path.
            return new Proxy(query, {
                get(pending, property) {
                    if (property === 'then')
                        return (
                            onFulfilled?: (value: unknown) => unknown,
                            onRejected?: (reason: unknown) => unknown,
                        ): Promise<unknown> =>
                            deadline
                                .awaitQuery(pending, 'fixture SQL query')
                                .then(onFulfilled, onRejected);
                    const value = Reflect.get(pending, property, pending) as unknown;
                    return typeof value === 'function' ? value.bind(pending) : value;
                },
            });
        },
        get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property === 'begin' || property === 'savepoint') {
                const transaction = value as (
                    callback: (tx: postgres.Sql) => Promise<unknown>,
                    ...args: unknown[]
                ) => Promise<unknown>;
                return (
                    callback: (tx: postgres.Sql) => Promise<unknown>,
                    ...args: unknown[]
                ): Promise<unknown> =>
                    transaction.call(
                        target,
                        (tx) => callback(deadlineAwareSql(tx, deadline)),
                        ...args,
                    );
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

async function assertNormalImageCapture(sql: postgres.Sql): Promise<void> {
    expect(
        await sql`SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid IN ('media_items'::regclass, 'image_candidates'::regclass)
          AND tgname IN ('image_urls_capture', 'image_candidate_reselect') ORDER BY tgname`,
    ).toEqual([
        { tgname: 'image_candidate_reselect', tgenabled: 'O' },
        { tgname: 'image_urls_capture', tgenabled: 'O' },
    ]);
    const [settings] =
        await sql`SELECT current_setting('lumastra.image_provenance_backfill',true) AS mirror,
        current_setting('lumastra.image_storage_normalization',true) AS election`;
    expect(settings.mirror).not.toBe('on');
    expect(settings.election).not.toBe('on');
}

interface ItemOpts {
    type: string;
    parent?: string | null;
    group?: string | null;
    /** Loss clock: 400 days, 10 days, or none. Default old. */
    lost?: 'old' | 'recent' | 'none';
    /** library_added_at set (former availability without a clock). */
    evidence?: boolean;
    status?: string;
    dismissed?: 'scanner' | 'operator';
    hasFiles?: boolean;
    createdRecently?: boolean;
    /** updated_at 60 days ago (legacy purge age). */
    staleUpdate?: boolean;
    /** dismissed_content_hash (scanner removal evidence). */
    hash?: string;
    season?: number;
    episode?: number;
    extraType?: string;
    metadata?: Record<string, unknown>;
}

async function item(sql: postgres.Sql, o: ItemOpts): Promise<string> {
    const id = crypto.randomUUID();
    const lost = o.lost ?? 'old';
    const lostAt =
        lost === 'old'
            ? sql`NOW() - INTERVAL '400 days'`
            : lost === 'recent'
              ? sql`NOW() - INTERVAL '10 days'`
              : sql`NULL`;
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, files_lost_at, library_group_id,
            parent_id, library_added_at, is_dismissed, dismissed_at, extra_type, season_number,
            episode_number, created_at, updated_at, custom_metadata, dismissed_content_hash)
        VALUES (${id}, ${`${o.type} ${id}`}, ${o.type}, ${o.status ?? 'active'}, ${o.hasFiles ?? false},
            ${lostAt}, ${o.group ?? null}, ${o.parent ?? null},
            ${o.evidence ? sql`NOW() - INTERVAL '500 days'` : sql`NULL`},
            ${o.dismissed !== undefined}, ${o.dismissed === 'scanner' ? sql`NOW() - INTERVAL '400 days'` : sql`NULL`},
            ${o.extraType ?? null}, ${o.season ?? null}, ${o.episode ?? null},
            ${o.createdRecently ? sql`NOW()` : sql`NOW() - INTERVAL '2 days'`},
            ${o.staleUpdate ? sql`NOW() - INTERVAL '60 days'` : sql`NOW()`},
            ${sql.json((o.metadata ?? {}) as postgres.JSONValue)}, ${o.hash ?? null})
    `;
    return id;
}

async function exists(sql: postgres.Sql, ids: string[]): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id::text AS id FROM media_items WHERE id = ANY(${ids}::uuid[]) ORDER BY id
    `;
    return rows.map((r) => r.id);
}

async function series(
    sql: postgres.Sql,
    group: string,
    opts: { episodeLost?: 'old' | 'recent' | 'none' } = {},
): Promise<{ root: string; seasons: string[]; episodes: string[]; extra: string }> {
    const root = await item(sql, { type: 'tv', group });
    const seasons = [
        await item(sql, { type: 'season', parent: root, season: 1, lost: 'none' }),
        await item(sql, { type: 'season', parent: root, season: 2, lost: 'none' }),
    ];
    const episodes = [
        await item(sql, {
            type: 'episode',
            parent: seasons[0],
            season: 1,
            episode: 1,
            lost: opts.episodeLost ?? 'old',
        }),
        await item(sql, { type: 'episode', parent: seasons[0], season: 1, episode: 2 }),
        // TMDB skeleton: never had a file.
        await item(sql, {
            type: 'episode',
            parent: seasons[1],
            season: 2,
            episode: 1,
            lost: 'none',
        }),
    ];
    const extra = await item(sql, {
        type: 'extra',
        parent: root,
        extraType: 'featurette',
        lost: 'none',
    });
    return { root, seasons, episodes, extra };
}

const run = (
    sql: postgres.Sql,
    dryRun = false,
    signal: AbortSignal = new AbortController().signal,
): ReturnType<typeof runMediaRetention> =>
    runMediaRetention(sql, { dryRun, batchLimit: 1000 }, signal);

async function candidateIds(sql: postgres.Sql, fx: Fx): Promise<string[]> {
    const evaluation = await evaluateRetentionUnits(
        sql,
        {
            track: [fx.g.music.group],
            album: [fx.g.music.group],
            movie: [fx.g.movie.group],
            series: [fx.g.tv.group],
        },
        1000,
    );
    return evaluation.candidates.map((c) => c.id);
}

describe('unavailable media retention', () => {
    beforeAll(() => {
        db = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(() => {
        vi.mocked(safeReaddir)
            .mockReset()
            .mockResolvedValue(healthyEntries as never);
        vi.mocked(safeAccess).mockReset().mockResolvedValue(undefined);
    });

    // ---------------------------------------------------------------------
    // I/O matrix
    // ---------------------------------------------------------------------

    it('leaves expired rows and unknown loss clocks untouched when retention is off', async () => {
        const setting = vi
            .spyOn(config, 'UNAVAILABLE_MEDIA_RETENTION_DAYS', 'get')
            .mockReturnValue(0);
        try {
            await inFixture(async ({ sql, g }) => {
                const expired = await item(sql, { type: 'movie', group: g.movie.group });
                const unknown = await item(sql, {
                    type: 'movie',
                    group: g.movie.group,
                    lost: 'none',
                });
                const result = await run(sql);
                expect(result).toMatchObject({
                    retentionDays: 0,
                    deletedRows: 0,
                    initialized: 0,
                    candidates: 0,
                });
                expect(result.reasons.join(' ')).toContain('disabled');
                expect(await exists(sql, [expired, unknown])).toHaveLength(2);
                expect(
                    (await sql`SELECT files_lost_at FROM media_items WHERE id = ${unknown}`)[0]
                        .files_lost_at,
                ).toBeNull();
            });
        } finally {
            setting.mockRestore();
        }
    });

    it.each(['movie', 'series'] as const)(
        'keeps an expired %s referenced by a curated list',
        async (kind) => {
            await inFixture(async (fx) => {
                const { sql, g } = fx;
                const root =
                    kind === 'movie'
                        ? await item(sql, { type: 'movie', group: g.movie.group })
                        : (await series(sql, g.tv.group)).root;
                expect(await candidateIds(sql, fx)).toContain(root);
                const list = `retention-${crypto.randomUUID()}`;
                await sql`INSERT INTO cached_lists (list_id, name, list_path) VALUES (${list}, 'Retention regression', ${list})`;
                await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${list}, ${root}, 1)`;
                expect(await candidateIds(sql, fx)).not.toContain(root);
                expect((await run(sql)).deletedIds).not.toContain(root);
                expect(await exists(sql, [root])).toHaveLength(1);
            });
        },
    );

    it('deletes a lost movie together with its extras', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            const extras = [
                await item(sql, {
                    type: 'extra',
                    parent: movie,
                    extraType: 'trailer',
                    lost: 'none',
                }),
                await item(sql, { type: 'extra', parent: movie, extraType: 'featurette' }),
            ];
            const result = await run(sql);
            expect(result.deletedIds).toContain(movie);
            expect(result.byKind.movie.deletedRows).toBeGreaterThanOrEqual(3);
            expect(await exists(sql, [movie, ...extras])).toEqual([]);
        });
    });

    it('keeps a fileless lost item with a personal-media disposition', async () => {
        await inFixture(async ({ sql, g, user }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            const extra = await item(sql, {
                type: 'extra',
                parent: movie,
                extraType: 'trailer',
                lost: 'none',
            });
            await sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
                VALUES (${movie}, 'kept', ${user})`;

            expect(await candidateIds(sql, { sql, g, user })).not.toContain(movie);
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(movie);
            expect(await exists(sql, [movie, extra])).toEqual([extra, movie].sort());
            expect(
                await sql`SELECT disposition, decided_by FROM personal_media_dispositions WHERE media_id = ${movie}`,
            ).toEqual([{ disposition: 'kept', decided_by: user }]);
        });
    });

    it('deletes a lost series with every season, episode and extra', async () => {
        await inFixture(async ({ sql, g }) => {
            const s = await series(sql, g.tv.group);
            const outcome = await MediaDeletionService.retentionDeleteUnit(sql, {
                id: s.root,
                kind: 'series',
                group_key: g.tv.group,
                files_lost_at: new Date(0),
            });
            expect(outcome).toMatchObject({ deleted: true, deletedCount: 7 });
            // Leaves first: the root is the last row removed.
            expect(outcome.deletedIds.at(-1)).toBe(s.root);
            expect(outcome.deletedIds.slice(0, 3).sort()).toEqual([...s.episodes].sort());
            expect(await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra])).toEqual([]);
        });
    });

    it('keeps the whole series when one episode has watch history', async () => {
        await inFixture(async ({ sql, g, user }) => {
            const s = await series(sql, g.tv.group);
            await sql`INSERT INTO watch_history (media_id, user_id, media_type, session_start_time)
                VALUES (${s.episodes[1]}, ${user}, 'episode', NOW())`;
            expect(await candidateIds(sql, { sql, g, user })).not.toContain(s.root);
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(s.root);
            expect(result.byKind.series.protected).toBeGreaterThanOrEqual(1);
            expect((await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra])).length).toBe(
                7,
            );
            expect(
                (
                    await MediaDeletionService.retentionDeleteUnit(sql, {
                        id: s.root,
                        kind: 'series',
                        group_key: g.tv.group,
                        files_lost_at: new Date(0),
                    })
                ).skipReason,
            ).toBe('eligibility-changed');
        });
    });

    it('never deletes lost episodes of a still-available series', async () => {
        await inFixture(async ({ sql, g, user }) => {
            const root = await item(sql, { type: 'tv', group: g.tv.group, hasFiles: true });
            const season = await item(sql, {
                type: 'season',
                parent: root,
                season: 1,
                hasFiles: true,
            });
            const lost = await item(sql, {
                type: 'episode',
                parent: season,
                season: 1,
                episode: 1,
                status: 'deleted',
            });
            const extra = await item(sql, { type: 'extra', parent: root, extraType: 'trailer' });
            expect(await candidateIds(sql, { sql, g, user })).not.toContain(root);
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(root);
            expect(await exists(sql, [root, season, lost, extra])).toHaveLength(4);
            // The legacy purge cannot remove the formerly-available episode either.
            expect(
                await findHardDeletableMediaIds(sql, new Date(Date.now() + 86400000)),
            ).not.toContain(lost);
        });
    });

    it('deletes a scanner-dismissed lost track, then its album once childless', async () => {
        await inFixture(async ({ sql, g }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const album = await item(sql, { type: 'album', parent: artist, group: g.music.group });
            // Tracks carry no library group; provenance comes from the album.
            const track = await item(sql, { type: 'track', parent: album, dismissed: 'scanner' });
            const first = await run(sql);
            expect(first.deletedIds).toContain(track);
            expect(first.deletedIds).not.toContain(album);
            expect(first.byKind.album.shapeBlocked).toBeGreaterThanOrEqual(1);
            expect(await exists(sql, [album, artist])).toHaveLength(2);
            const second = await run(sql);
            expect(second.deletedIds).toContain(album);
            // The last expired album also removes its unreferenced artist.
            expect(await exists(sql, [track, album, artist])).toEqual([]);
        });
    });

    it('missing files hide music and metadata immediately, and returning files restore the same rows', async () => {
        await inFixture(async ({ sql, g, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const album = await item(sql, {
                type: 'album',
                parent: artist,
                group: g.music.group,
                lost: 'none',
            });
            const track = await item(sql, {
                type: 'track',
                parent: album,
                lost: 'none',
                metadata: { genre: ['OrphanRegression'] },
            });
            await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite) VALUES (${user}, ${track}, true)`;
            await sql`UPDATE media_items SET title = 'OrphanRegression' WHERE id = ANY(${[album, track]}::uuid[])`;
            await sql`UPDATE media_items SET custom_poster_url = '/api/image/custom/' || id || '/poster' WHERE id = ${album}`;
            const [original] =
                await sql`SELECT title, created_at, custom_metadata FROM media_items WHERE id = ${track}`;
            const path = `${g.music.dir}/regression.mp3`;
            const file = await upsertMediaFile(sql, {
                filePath: path,
                libraryGroupId: g.music.group,
            });
            await attachFileToItem(sql, file.id, track);
            const albums = (): Promise<string[]> =>
                getAlbums(sql, { access: unrestrictedAccess() }).then((rows) =>
                    rows.map((r) => r.id),
                );
            const covers = (): ReturnType<typeof getGenreCoverAlbums> =>
                getGenreCoverAlbums(sql, ['OrphanRegression'], {
                    deniedGroupIds: null,
                    ageRating: null,
                });
            expect(await albums()).toContain(album);
            expect(await covers()).toContainEqual({ genre: 'OrphanRegression', album_id: album });
            expect(await findTrackFileForAlbum(sql, album)).not.toBeNull();
            await markFileMissing(sql, file.id);
            await backfillHasFilesMediaItems(sql);
            const lost =
                await sql`SELECT id, has_files, files_lost_at FROM media_items WHERE id = ANY(${[artist, album, track]}::uuid[])`;
            expect(lost).toHaveLength(3);
            for (const row of lost) {
                expect(row.has_files).toBe(false);
                expect(row.files_lost_at).not.toBeNull();
            }
            // Periodic drift repair also heals historic missing-file flags,
            // and its backfill must not resurrect them on the next tick.
            await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[artist, album, track]}::uuid[])`;
            await clearStaleHasFilesMediaItems(sql);
            await backfillHasFilesMediaItems(sql);
            expect(
                await sql`SELECT id FROM media_items WHERE id = ANY(${[artist, album, track]}::uuid[]) AND has_files`,
            ).toHaveLength(0);
            expect(await albums()).not.toContain(album);
            expect(await covers()).toEqual([]);
            expect(await findTrackFileForAlbum(sql, album)).toBeNull();
            expect(
                (await getDistinctMusicGenres(sql, { deniedGroupIds: null, ageRating: null })).map(
                    (r) => r.genre,
                ),
            ).not.toContain('OrphanRegression');
            const hits = await searchMusic(sql, 'OrphanRegression', 50, unrestrictedAccess());
            expect(hits.map((r) => r.id)).not.toContain(album);
            expect(hits.map((r) => r.id)).not.toContain(track);
            expect((await run(sql)).deleted).toBe(0);
            await upsertMediaFile(sql, { filePath: path, libraryGroupId: g.music.group });
            await attachFileToItem(sql, file.id, track);
            expect(await albums()).toContain(album);
            expect(await covers()).toHaveLength(1);
            expect(
                (
                    await sql`SELECT title, created_at, custom_metadata FROM media_items WHERE id = ${track}`
                )[0],
            ).toEqual(original);
            expect(
                (
                    await sql`SELECT is_favorite FROM user_media_state WHERE user_id = ${user} AND media_id = ${track}`
                )[0].is_favorite,
            ).toBe(true);
            const restored =
                await sql`SELECT has_files, files_lost_at FROM media_items WHERE id = ANY(${[artist, album, track]}::uuid[])`;
            expect(restored).toHaveLength(3);
            for (const row of restored) {
                expect(row.has_files).toBe(true);
                expect(row.files_lost_at).toBeNull();
            }
            // The normal watcher deletion path starts the same grace period.
            await deleteStaleMediaFile(sql, path);
            expect(
                (await sql`SELECT is_dismissed FROM media_items WHERE id = ${track}`)[0]
                    .is_dismissed,
            ).toBe(true);
            expect(await albums()).not.toContain(album);
            await upsertMediaFile(sql, { filePath: path, libraryGroupId: g.music.group }).then(
                (f) => attachFileToItem(sql, f.id, track),
            );
            expect(await albums()).toContain(album);
        });
    });

    it('expires missing-file links using the configured window, keeping another available version', async () => {
        const setting = vi
            .spyOn(config, 'UNAVAILABLE_MEDIA_RETENTION_DAYS', 'get')
            .mockReturnValue(14);
        try {
            await inFixture(async ({ sql, g }) => {
                const artist = await item(sql, { type: 'artist', lost: 'none' });
                const album = await item(sql, {
                    type: 'album',
                    parent: artist,
                    group: g.music.group,
                    lost: 'none',
                });
                const track = await item(sql, { type: 'track', parent: album, lost: 'none' });
                const other = await item(sql, { type: 'track', parent: album, lost: 'none' });
                const missing = await upsertMediaFile(sql, {
                    filePath: `${g.music.dir}/missing.mp3`,
                });
                const present = await upsertMediaFile(sql, {
                    filePath: `${g.music.dir}/present.mp3`,
                });
                await attachFileToItem(sql, missing.id, track);
                await attachFileToItem(sql, present.id, other);
                await markFileMissing(sql, missing.id);
                expect(
                    (await sql`SELECT has_files FROM media_items WHERE id = ${album}`)[0].has_files,
                ).toBe(true);
                await sql`UPDATE media_items SET files_lost_at = NOW() - INTERVAL '13 days' WHERE id = ${track}`;
                expect((await run(sql)).deletedIds).not.toContain(track);
                await sql`UPDATE media_items SET files_lost_at = NOW() - INTERVAL '15 days' WHERE id = ${track}`;
                const result = await run(sql);
                expect(result.retentionDays).toBe(14);
                expect(result.deletedIds).toContain(track);
                expect(await exists(sql, [artist, album, other])).toHaveLength(3);
                expect(await sql`SELECT id FROM media_files WHERE id = ${missing.id}`).toHaveLength(
                    0,
                );
            });
        } finally {
            setting.mockRestore();
        }
    });

    it.each(['rating', 'favourite', 'playlist', 'listen', 'curation', 'assistant-history'])(
        'keeps music with %s data during retention',
        async (protection) => {
            await inFixture(async ({ sql, user, g }) => {
                const artist = await item(sql, { type: 'artist', lost: 'none' });
                const album = await item(sql, {
                    type: 'album',
                    parent: artist,
                    group: g.music.group,
                });
                const track = await item(sql, { type: 'track', parent: album });
                if (protection === 'rating')
                    await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${track}, 8)`;
                if (protection === 'favourite')
                    await sql`INSERT INTO user_media_state (user_id, media_id, is_favorite) VALUES (${user}, ${track}, true)`;
                if (protection === 'playlist') {
                    const [list] =
                        await sql`INSERT INTO playlists (name, user_id) VALUES ('Retention', ${user}) RETURNING id`;
                    await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position) VALUES (${list.id}, ${track}, 'Retained', 0)`;
                }
                if (protection === 'listen')
                    await sql`INSERT INTO user_music_state (user_id, track_id, play_count) VALUES (${user}, ${track}, 1)`;
                if (protection === 'curation')
                    await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${track}`;
                if (protection === 'assistant-history')
                    await sql`INSERT INTO assistant_messages (user_id, role, content, context_media_ids) VALUES (${user}, 'assistant', 'Retained', ${[track]}::uuid[])`;
                await run(sql);
                await run(sql);
                expect(await exists(sql, [artist, album, track])).toHaveLength(3);
            });
        },
    );

    it.each(['rating', 'curation', 'credit', 'assistant-history'])(
        'keeps an empty artist with %s protection after its last album expires',
        async (protection) => {
            await inFixture(async ({ sql, user, g }) => {
                const artist = await item(sql, { type: 'artist', lost: 'none' });
                const album = await item(sql, {
                    type: 'album',
                    parent: artist,
                    group: g.music.group,
                });
                if (protection === 'rating')
                    await sql`INSERT INTO user_ratings (user_id, media_id, rating) VALUES (${user}, ${artist}, 8)`;
                if (protection === 'curation')
                    await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${artist}`;
                if (protection === 'credit')
                    await item(sql, {
                        type: 'track',
                        lost: 'none',
                        metadata: {
                            track_artist_credits: [
                                {
                                    id: artist.replace(/-/g, '').toUpperCase(),
                                    credited_name: 'Still credited',
                                },
                            ],
                        },
                    });
                if (protection === 'assistant-history')
                    await sql`INSERT INTO assistant_messages (user_id, role, content, context_media_ids) VALUES (${user}, 'assistant', 'Artist', ${[artist]}::uuid[])`;
                expect((await run(sql)).deletedIds).toContain(album);
                expect(await exists(sql, [artist])).toEqual([artist]);
            });
        },
    );

    it('removes a credit-only artist when its last expired track is removed', async () => {
        await inFixture(async ({ sql, g }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const credited = await item(sql, {
                type: 'artist',
                lost: 'none',
                metadata: { musicbrainz_artist_id: crypto.randomUUID() },
            });
            const album = await item(sql, { type: 'album', parent: artist, group: g.music.group });
            const track = await item(sql, {
                type: 'track',
                parent: album,
                metadata: { additional_artist_ids: [credited] },
            });
            expect((await run(sql)).deletedIds).toContain(track);
            expect(await exists(sql, [credited])).toEqual([]);
            expect(await exists(sql, [artist, album])).toHaveLength(2);
        });
    });

    it('never touches never-owned discovery and skeleton rows', async () => {
        await inFixture(async ({ sql, g }) => {
            const discovery = await item(sql, { type: 'tv', group: g.tv.group, lost: 'none' });
            const skeletonSeason = await item(sql, {
                type: 'season',
                parent: discovery,
                season: 1,
                lost: 'none',
            });
            const movie = await item(sql, { type: 'movie', group: g.movie.group, lost: 'none' });
            const groups = await findRetentionRootGroups(sql);
            const result = await run(sql);
            expect(
                groups.filter((r) => r.group_key === g.tv.group || r.group_key === g.movie.group),
            ).toEqual([]);
            expect(result.deletedIds).not.toContain(discovery);
            expect(
                await sql`SELECT files_lost_at FROM media_items WHERE id = ANY(${[discovery, skeletonSeason, movie]}::uuid[]) AND files_lost_at IS NOT NULL`,
            ).toHaveLength(0);
        });
    });

    it('starts an unknown loss clock at NOW() in a real run only, never from creation age', async () => {
        await inFixture(async ({ sql, g }) => {
            const old = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                lost: 'none',
                evidence: true,
            });
            await sql`UPDATE media_items SET created_at = NOW() - INTERVAL '10 years' WHERE id = ${old}`;
            const fresh = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                lost: 'none',
                evidence: true,
                createdRecently: true,
            });
            const preview = await run(sql, true);
            expect(preview.byKind.movie.unknownAge).toBeGreaterThanOrEqual(1);
            expect(preview.initialized).toBe(0);
            const clock = async (id: string): Promise<Date | null> =>
                (
                    await sql<
                        { files_lost_at: Date | null }[]
                    >`SELECT files_lost_at FROM media_items WHERE id = ${id}`
                )[0].files_lost_at;
            expect(await clock(old)).toBeNull();
            const actual = await run(sql);
            expect(actual.byKind.movie.initialized).toBeGreaterThanOrEqual(1);
            expect(actual.deletedIds).not.toContain(old);
            const started = await clock(old);
            expect(started).not.toBeNull();
            expect(Date.now() - new Date(started!).getTime()).toBeLessThan(60_000);
            expect(await clock(fresh)).toBeNull();
            // A started clock is not yet a year old: the next run deletes nothing.
            expect((await run(sql)).deletedIds).not.toContain(old);
        });
    });

    it.each([
        { label: 'disabled root', opts: { enabled: false }, reason: 'disabled-root' },
        { label: 'stale scan', opts: { completedAgo: '8 days' }, reason: 'stale-or-invalid-scan' },
        { label: 'failed scan', opts: { state: 'failed' }, reason: 'incomplete-or-missing-scan' },
        { label: 'missing scan', opts: { scan: null }, reason: 'incomplete-or-missing-scan' },
        {
            label: 'erroring scan',
            opts: {
                scan: {
                    success: true,
                    itemsProcessed: 1,
                    result: { scanErrors: 9, added: 1, updated: 0, skipped: 90, unmatched: 0 },
                },
            },
            reason: 'scan-errors-or-unknown',
        },
        {
            label: 'unsuccessful envelope',
            opts: { scan: { ...SCAN_OK, success: false } },
            reason: 'unknown-scan-result',
        },
        {
            label: 'legacy flat counts',
            opts: { scan: SCAN_OK.result },
            reason: 'unknown-scan-result',
        },
        { label: 'empty root', opts: {}, reason: 'empty-or-unusable-root' },
    ])('skips only the group with a $label; healthy groups proceed', async ({ opts, reason }) => {
        await inFixture(async ({ sql, g }) => {
            const bad = await addGroup(sql, 'movie', opts);
            if (reason === 'empty-or-unusable-root')
                vi.mocked(safeReaddir).mockImplementation(
                    async (path: string) => (path === bad.dir ? [] : healthyEntries) as never,
                );
            const kept = await item(sql, { type: 'movie', group: bad.group });
            const keptUnknown = await item(sql, {
                type: 'movie',
                group: bad.group,
                lost: 'none',
                evidence: true,
            });
            const gone = await item(sql, { type: 'movie', group: g.movie.group });
            const result = await run(sql);
            expect(result.deletedIds).toContain(gone);
            expect(result.deletedIds).not.toContain(kept);
            expect(result.reasons.find((r) => r.includes(bad.group))).toContain(reason);
            expect(result.byKind.movie.unhealthyGroup).toBeGreaterThanOrEqual(2);
            expect(await exists(sql, [kept, keptUnknown])).toHaveLength(2);
            expect(
                (await sql`SELECT files_lost_at FROM media_items WHERE id = ${keptUnknown}`)[0]
                    .files_lost_at,
            ).toBeNull();
        });
    });

    it('reports roots without library provenance instead of deleting them', async () => {
        await inFixture(async ({ sql }) => {
            const orphan = await item(sql, { type: 'track', group: null });
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(orphan);
            expect(result.byKind.track.missingProvenance).toBeGreaterThanOrEqual(1);
            expect(result.reasons.some((r) => r.startsWith('track: '))).toBe(true);
        });
    });

    it('the latest per-path scan wins; a global fan-out run does not substitute', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at)
                VALUES (${crypto.randomUUID()}, 'file-library-scan', 'failed', 'failed',
                        ${sql.json({ libraryPathId: g.movie.path })}, '{}', '{}', '1', NOW() - INTERVAL '30 minutes')`;
            // A newer successful fan-out run (no libraryPathId) proves nothing per path.
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, result)
                VALUES (${crypto.randomUUID()}, 'file-library-scan', 'fan-out', 'completed', '{}', '{}', '{}', '1',
                        NOW() - INTERVAL '10 minutes', NOW(), ${sql.json(SCAN_OK)})`;
            const [evidence] = await getLibraryGroupScanEvidence(sql, [g.movie.group]);
            expect(evidence.state).toBe('failed');
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(movie);
            expect(result.reasons.find((r) => r.includes(g.movie.group))).toContain(
                'incomplete-or-missing-scan',
            );
        });
    });

    it('health that fails on the in-transaction recheck keeps units and is not probed again', async () => {
        await inFixture(async ({ sql, g }) => {
            const known = await item(sql, { type: 'movie', group: g.movie.group });
            const unknown = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                lost: 'none',
                evidence: true,
            });
            let offline = false;
            // Discovery sees a healthy mount; the root goes away before the unit locks.
            vi.mocked(safeReaddir).mockImplementation(async (path: string) => {
                if (path === g.movie.dir) offline = true;
                return healthyEntries as never;
            });
            vi.mocked(safeAccess).mockImplementation(async (path: string) => {
                if (offline && path === g.movie.dir) throw new Error('root went offline');
            });
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(known);
            expect(result.byKind.movie.skipped).toBeGreaterThanOrEqual(2);
            expect(result.reasons.some((r) => r.startsWith('library-health-changed'))).toBe(true);
            expect(result.reasons.find((r) => r.startsWith('library-health-changed'))).toContain(
                'inaccessible-root',
            );
            // One discovery probe plus one failed recheck; the second unit reuses the memo.
            expect(
                vi.mocked(safeAccess).mock.calls.filter(([path]) => path === g.movie.dir),
            ).toHaveLength(2);
            expect(await exists(sql, [known, unknown])).toHaveLength(2);
            expect(
                (await sql`SELECT files_lost_at FROM media_items WHERE id = ${unknown}`)[0]
                    .files_lost_at,
            ).toBeNull();
        });
    });

    it('an anime path group covers a series unit; a group mixing movie and tv paths does not', async () => {
        await inFixture(async ({ sql }) => {
            const anime = await addGroup(sql, 'anime');
            const animeSeries = await item(sql, { type: 'tv', group: anime.group });
            const season = await item(sql, {
                type: 'season',
                parent: animeSeries,
                season: 1,
                lost: 'none',
            });
            const mixed = await addGroup(sql, 'movie');
            await addPath(sql, mixed.group, 'tv');
            const mixedMovie = await item(sql, { type: 'movie', group: mixed.group });
            const result = await run(sql);
            expect(result.deletedIds).toContain(animeSeries);
            expect(await exists(sql, [animeSeries, season])).toEqual([]);
            expect(result.deletedIds).not.toContain(mixedMovie);
            expect(result.reasons.find((r) => r.includes(mixed.group))).toContain('kind-mismatch');
        });
    });

    describe('audiobooks', () => {
        async function absPath(
            sql: postgres.Sql,
            sync: Record<string, unknown> = {
                success: true,
                itemsProcessed: 0,
                result: {
                    added: 0,
                    updated: 0,
                    dismissed: 0,
                    unmatched: 0,
                    skipped: 5,
                    errors: [],
                },
            },
        ): Promise<string> {
            const group = crypto.randomUUID(),
                path = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
            await sql`INSERT INTO library_paths (id, path, media_type, provider, provider_path, library_group_id, updated_at)
                VALUES (${path}, ${'abs://' + path}, 'audiobook', 'audiobookshelf', ${path}, ${group}, NOW() - INTERVAL '2 hours')`;
            await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, result)
                VALUES (${crypto.randomUUID()}, 'audiobookshelf-sync', 'test sync', 'completed', '{}'::jsonb, '{}'::jsonb,
                        '{}'::jsonb, '1', NOW() - INTERVAL '1 minute', NOW(), ${sql.json(sync as postgres.JSONValue)})`;
            return path;
        }
        async function book(
            sql: postgres.Sql,
            path: string,
            state: 'gone' | 'listed-missing' | 'operator' | 'recent',
        ): Promise<string> {
            const id = await item(sql, {
                type: 'audiobook',
                lost: 'none',
                evidence: true,
                metadata: { audiobookshelf: { libraryPathId: path, libraryId: path } },
            });
            if (state === 'gone')
                await sql`UPDATE media_items SET is_dismissed = true, dismissed_at = NOW() - INTERVAL '400 days' WHERE id = ${id}`;
            else if (state === 'recent')
                await sql`UPDATE media_items SET is_dismissed = true, dismissed_at = NOW() - INTERVAL '10 days' WHERE id = ${id}`;
            else if (state === 'operator')
                await sql`UPDATE media_items SET is_dismissed = true, dismissed_at = NULL WHERE id = ${id}`;
            return id;
        }

        it('deletes books absent upstream for a year and keeps listed or curated ones', async () => {
            await inFixture(async ({ sql }) => {
                const path = await absPath(sql);
                const gone = await book(sql, path, 'gone');
                const listed = await book(sql, path, 'listed-missing');
                const operator = await book(sql, path, 'operator');
                const recent = await book(sql, path, 'recent');
                const result = await run(sql);
                expect(result.deletedIds).toContain(gone);
                expect(result.byKind.audiobook.deleted).toBeGreaterThanOrEqual(1);
                expect(await exists(sql, [gone, listed, operator, recent])).toEqual(
                    [listed, operator, recent].sort(),
                );
            });
        });

        it('counts only global syncs or syncs scoped to the same path', async () => {
            await inFixture(async ({ sql }) => {
                // Old global run failed; a newer clean run covered a different path.
                const path = await absPath(sql, { success: false, itemsProcessed: 0 });
                const gone = await book(sql, path, 'gone');
                const sync = (input: Record<string, unknown>, ago: string): Promise<unknown> =>
                    sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, result)
                        VALUES (${crypto.randomUUID()}, 'audiobookshelf-sync', 'scoped sync', 'completed',
                                ${sql.json(input as postgres.JSONValue)}, '{}'::jsonb, '{}'::jsonb, '1',
                                NOW() - ${ago}::interval, NOW() - ${ago}::interval + INTERVAL '1 second',
                                ${sql.json({
                                    success: true,
                                    itemsProcessed: 0,
                                    result: {
                                        added: 0,
                                        updated: 0,
                                        dismissed: 0,
                                        unmatched: 0,
                                        skipped: 5,
                                        errors: [],
                                    },
                                })})`;
                await sync({ libraryPathId: crypto.randomUUID() }, '20 seconds');
                const blocked = await run(sql);
                expect(blocked.deletedIds).not.toContain(gone);
                expect(blocked.reasons.find((r) => r.includes(path))).toContain(
                    'unknown-sync-result',
                );
                await sync({ libraryPathId: path }, '10 seconds');
                expect((await run(sql)).deletedIds).toContain(gone);
            });
        });

        it('keeps a book that came back upstream', async () => {
            await inFixture(async ({ sql }) => {
                const path = await absPath(sql);
                const back = await book(sql, path, 'gone');
                await setAudiobookFlags(sql, [back], { hasFiles: true, isDismissed: false });
                await setAudiobookFlags(sql, [back], { hasFiles: false, isDismissed: false });
                const result = await run(sql);
                expect(result.deletedIds).not.toContain(back);
                expect(await exists(sql, [back])).toEqual([back]);
            });
        });

        it.each([
            {
                label: 'sync errors',
                sync: {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        added: 0,
                        updated: 0,
                        dismissed: 0,
                        unmatched: 0,
                        skipped: 5,
                        errors: ['x'],
                    },
                },
                reason: 'sync-errors-or-unknown',
            },
            {
                label: 'empty sync',
                sync: {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        added: 0,
                        updated: 0,
                        dismissed: 0,
                        unmatched: 0,
                        skipped: 0,
                        errors: [],
                    },
                },
                reason: 'empty-or-unknown-sync',
            },
        ])('fails closed on $label', async ({ sync, reason }) => {
            await inFixture(async ({ sql }) => {
                const path = await absPath(sql, sync);
                const gone = await book(sql, path, 'gone');
                const result = await run(sql);
                expect(result.deletedIds).not.toContain(gone);
                expect(result.reasons.find((r) => r.includes(path))).toContain(reason);
            });
        });

        describe('per-library sync slices', () => {
            const slice = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
                listed: true,
                added: 0,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 5,
                errors: 0,
                ...patch,
            });

            /** Two ABS paths covered by ONE global sync whose run-wide errors are non-empty. */
            async function twoPathsOneSync(
                sql: postgres.Sql,
                libraries: (a: string, b: string) => Record<string, unknown>,
            ): Promise<{ a: string; b: string }> {
                const paths: string[] = [];
                for (let i = 0; i < 2; i++) {
                    const group = crypto.randomUUID(),
                        path = crypto.randomUUID();
                    await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
                    await sql`INSERT INTO library_paths (id, path, media_type, provider, provider_path, library_group_id, updated_at)
                        VALUES (${path}, ${'abs://' + path}, 'audiobook', 'audiobookshelf', ${path}, ${group}, NOW() - INTERVAL '2 hours')`;
                    paths.push(path);
                }
                const [a, b] = paths;
                await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at, completed_at, result)
                    VALUES (${crypto.randomUUID()}, 'audiobookshelf-sync', 'test sync', 'completed', '{}'::jsonb, '{}'::jsonb,
                            '{}'::jsonb, '1', NOW() - INTERVAL '1 minute', NOW(),
                            ${sql.json({
                                success: true,
                                itemsProcessed: 0,
                                result: {
                                    added: 0,
                                    updated: 0,
                                    dismissed: 0,
                                    unmatched: 0,
                                    skipped: 10,
                                    errors: ['Library b: something failed'],
                                    libraries: libraries(a, b),
                                },
                            } as postgres.JSONValue)})`;
                return { a, b };
            }

            it.each([
                {
                    label: 'a failed listing',
                    b: slice({ listed: false, skipped: 0, errors: 1 }),
                    reason: 'abs-library-not-listed',
                },
                {
                    label: 'a tripped dismissal cap',
                    b: slice({ skipped: 40, errors: 1 }),
                    reason: 'sync-errors-or-unknown',
                },
                {
                    label: 'a path missing from the run',
                    b: undefined,
                    reason: 'abs-library-not-in-sync',
                },
            ])('$label fails only that path', async ({ b: bSlice, reason }) => {
                await inFixture(async ({ sql }) => {
                    const { a, b } = await twoPathsOneSync(sql, (pa, pb) =>
                        bSlice === undefined ? { [pa]: slice() } : { [pa]: slice(), [pb]: bSlice },
                    );
                    const goneA = await book(sql, a, 'gone');
                    const goneB = await book(sql, b, 'gone');
                    const result = await run(sql);
                    expect(result.deletedIds).toContain(goneA);
                    expect(result.deletedIds).not.toContain(goneB);
                    expect(await exists(sql, [goneB])).toEqual([goneB]);
                    expect(result.reasons.find((r) => r.includes(a))).toBeUndefined();
                    expect(result.reasons.find((r) => r.includes(b))).toContain(reason);
                });
            });
        });
    });

    it('keeps expired linked missing tracks when even one subtree failed to scan', async () => {
        await inFixture(async ({ sql, g }) => {
            const track = await item(sql, { type: 'track', group: g.music.group });
            const file = await upsertMediaFile(sql, {
                filePath: `${g.music.dir}/failed/track.mp3`,
            });
            await attachFileToItem(sql, file.id, track);
            await markFileMissing(sql, file.id);
            await sql`UPDATE media_items SET files_lost_at = NOW() - INTERVAL '400 days' WHERE id = ${track}`;
            await sql`UPDATE task_history SET result = ${sql.json({
                success: true,
                result: { scanErrors: 1, added: 0, updated: 0, skipped: 999, unmatched: 0 },
            })} WHERE input->>'libraryPathId' = ${g.music.path}`;
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(track);
            expect(result.reasons.join(' ')).toContain('scan-errors-or-unknown');
            expect(await exists(sql, [track])).toEqual([track]);
            await sql`UPDATE task_history SET result = ${sql.json(SCAN_OK)}
                WHERE input->>'libraryPathId' = ${g.music.path}`;
            expect((await run(sql)).deletedIds).toContain(track);
        });
    });

    it.each(['path', 'global'] as const)(
        'serializes %s scan registration with retention and rechecks committed starts',
        async (scope) => {
            const g = await addGroup(db, 'movie');
            const movie = await item(db, { type: 'movie', group: g.group });
            const target: RetentionUnitCandidate = {
                id: movie,
                kind: 'movie',
                group_key: g.group,
                files_lost_at: new Date(Date.now() - 200 * 86400000),
            };
            const scanner = postgres(getTestDatabaseUrl(), { max: 1 });
            const retention = postgres(getTestDatabaseUrl(), { max: 1 });
            let release = (): void => {};
            let ready = (): void => {};
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const held = new Promise<void>((resolve) => {
                ready = resolve;
            });
            let registration: Promise<string> | undefined;
            let scanId: string | undefined;
            const holding = retention.begin(async (tx) => {
                const locked = await lockRetentionUnit(tx as unknown as postgres.Sql, target);
                expect('skipReason' in locked).toBe(false);
                ready();
                await gate;
            });
            try {
                // Surface setup failures immediately instead of hanging on readiness.
                await Promise.race([held, holding]);
                const [pid] = await scanner<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                registration = insertScannerRun(scanner, {
                    libraryPathId: scope === 'path' ? g.path : undefined,
                    startedAt: new Date(),
                });
                await vi.waitFor(async () => {
                    expect(
                        (
                            await db`SELECT cardinality(pg_blocking_pids(${pid.pid})) > 0 AS blocked`
                        )[0].blocked,
                    ).toBe(true);
                });
                release();
                await holding;
                scanId = await registration;
                // The earlier healthy snapshot cannot authorize deletion after a scan registered.
                const outcome = await MediaDeletionService.retentionDeleteUnit(db, target);
                expect(outcome.deleted).toBe(false);
                expect(outcome.skipReason).toContain('incomplete-or-missing-scan');
                expect(await exists(db, [movie])).toEqual([movie]);
            } finally {
                release();
                const settled = await Promise.allSettled([holding, registration] as const);
                if (settled[1].status === 'fulfilled') scanId = settled[1].value;
                if (scanId) await db`DELETE FROM file_scanner_runs WHERE id = ${scanId}`;
                await Promise.all([scanner.end(), retention.end()]);
                await db`DELETE FROM media_items WHERE id = ${movie}`;
                await db`DELETE FROM task_history WHERE input->>'libraryPathId' = ${g.path}`;
                await db`DELETE FROM library_paths WHERE id = ${g.path}`;
                await db`DELETE FROM library_groups WHERE id = ${g.group}`;
            }
        },
    );

    it.each(['path', 'group', 'global'])(
        'an in-flight %s scan fences retention even when another scan completed later',
        async (scope) => {
            await inFixture(async ({ sql, g }) => {
                const movie = await item(sql, { type: 'movie', group: g.movie.group });
                const unrelated = await item(sql, { type: 'track', group: g.music.group });
                const input =
                    scope === 'path'
                        ? { libraryPathId: g.movie.path }
                        : scope === 'group'
                          ? { libraryGroupId: g.movie.group }
                          : {};
                for (const state of ['pending', 'active'])
                    await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version, started_at)
                        VALUES (${crypto.randomUUID()}, 'file-library-scan', 'in flight', ${state},
                                ${sql.json(input)}, '{}', '{}', '1', NOW() - INTERVAL '2 hours')`;
                const [evidence] = await getLibraryGroupScanEvidence(sql, [g.movie.group]);
                expect(['pending', 'active']).toContain(evidence.state);
                const result = await run(sql);
                expect(result.deletedIds).not.toContain(movie);
                expect(await exists(sql, [movie])).toEqual([movie]);
                if (scope === 'path') expect(result.deletedIds).toContain(unrelated);
                else expect(result.deletedIds).not.toContain(unrelated);
            });
        },
    );

    it('a series stays when one episode lost its files only recently', async () => {
        await inFixture(async (fx) => {
            const s = await series(fx.sql, fx.g.tv.group, { episodeLost: 'recent' });
            expect(await candidateIds(fx.sql, fx)).not.toContain(s.root);
            const result = await run(fx.sql);
            expect(result.deletedIds).not.toContain(s.root);
            expect(await exists(fx.sql, [s.root, ...s.episodes])).toHaveLength(4);
        });
    });

    it('a hash-only removal record starts a clock and is never purged by the 30-day path', async () => {
        await inFixture(async ({ sql, g }) => {
            const hashed = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                lost: 'none',
                hash: 'abc',
            });
            const result = await run(sql);
            expect(result.byKind.movie.initialized).toBeGreaterThanOrEqual(1);
            expect(
                (await sql`SELECT files_lost_at FROM media_items WHERE id = ${hashed}`)[0]
                    .files_lost_at,
            ).not.toBeNull();
            const stale = await item(sql, {
                type: 'movie',
                lost: 'none',
                status: 'deleted',
                staleUpdate: true,
                hash: 'def',
            });
            const twin = await item(sql, {
                type: 'movie',
                lost: 'none',
                status: 'deleted',
                staleUpdate: true,
            });
            const ids = await findHardDeletableMediaIds(
                sql,
                new Date(Date.now() - 30 * 86400000),
                100_000,
            );
            expect(ids).not.toContain(stale);
            // The same row without the hash is a never-owned stub the old purge may take.
            expect(ids).toContain(twin);
        });
    });

    it('fires lifecycle cleanup for every deleted row and recomputes the surviving parent', async () => {
        await inFixture(async ({ sql, g }) => {
            vi.mocked(MediaLifecycleService.afterDeletedBatch).mockClear();
            const s = await series(sql, g.tv.group);
            const outcome = await MediaDeletionService.retentionDeleteUnit(sql, {
                id: s.root,
                kind: 'series',
                group_key: g.tv.group,
                files_lost_at: new Date(0),
            });
            expect(outcome.deleted).toBe(true);
            const [ids, root] = vi
                .mocked(MediaLifecycleService.afterDeletedBatch)
                .mock.calls.at(-1)!;
            expect([...ids].sort()).toEqual([s.root, ...s.seasons, ...s.episodes, s.extra].sort());
            expect(root).toBe(s.root);

            // A stale has_files on the parent album is recomputed once its track is gone.
            const album = await item(sql, { type: 'album', group: g.music.group, lost: 'recent' });
            const track = await item(sql, { type: 'track', parent: album });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${album}`;
            expect(
                (
                    await MediaDeletionService.retentionDeleteUnit(sql, {
                        id: track,
                        kind: 'track',
                        group_key: g.music.group,
                        files_lost_at: new Date(0),
                    })
                ).deleted,
            ).toBe(true);
            expect(
                (await sql`SELECT has_files FROM media_items WHERE id = ${album}`)[0].has_files,
            ).toBe(false);
        });
    });

    it('a unit deeper than the walk cap is never deleted, not even partly', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            let parent = movie;
            const chain: string[] = [];
            for (let i = 0; i < 66; i++) {
                parent = await item(sql, {
                    type: 'extra',
                    parent,
                    extraType: 'extra',
                    lost: 'none',
                });
                chain.push(parent);
            }
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(movie);
            expect(result.byKind.movie.shapeBlocked).toBeGreaterThanOrEqual(1);
            const outcome = await MediaDeletionService.retentionDeleteUnit(sql, {
                id: movie,
                kind: 'movie',
                group_key: g.movie.group,
                files_lost_at: new Date(0),
            });
            expect(outcome).toMatchObject({ deleted: false, skipReason: 'unit-too-deep' });
            expect(await exists(sql, [movie, ...chain])).toHaveLength(67);
        });
    });

    it('automatic dismissal writers keep an operator dismissal operator-owned', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                dismissed: 'operator',
            });
            await MediaDeletionService.softDismiss(sql, movie);
            const book = await item(sql, {
                type: 'audiobook',
                lost: 'none',
                dismissed: 'operator',
            });
            await setAudiobookFlags(sql, [book], { hasFiles: false, isDismissed: true });
            expect(
                await sql`SELECT dismissed_at FROM media_items WHERE id = ANY(${[movie, book]}::uuid[])`,
            ).toEqual([{ dismissed_at: null }, { dismissed_at: null }]);
            expect((await run(sql)).deletedIds).not.toContain(movie);

            // A fresh automatic dismissal is stamped (and later counts as lost).
            const fresh = await item(sql, { type: 'movie', group: g.movie.group, lost: 'none' });
            await MediaDeletionService.softDismiss(sql, fresh);
            const freshBook = await item(sql, { type: 'audiobook', lost: 'none' });
            await setAudiobookFlags(sql, [freshBook], { hasFiles: false, isDismissed: true });
            expect(
                await sql`SELECT 1 FROM media_items WHERE id = ANY(${[fresh, freshBook]}::uuid[]) AND dismissed_at IS NOT NULL`,
            ).toHaveLength(2);
        });
    });

    it('a returned file clears the clock and keeps the row', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie}`;
            await sql`UPDATE media_items SET has_files = false WHERE id = ${movie}`;
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(movie);
            const [row] = await sql<
                { files_lost_at: Date }[]
            >`SELECT files_lost_at FROM media_items WHERE id = ${movie}`;
            expect(Date.now() - new Date(row.files_lost_at).getTime()).toBeLessThan(60_000);
        });
    });

    it('preview reports the same classes as a real run and writes nothing (real task adapter)', async () => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            const extra = await item(sql, { type: 'extra', parent: movie, extraType: 'trailer' });
            const unknown = await item(sql, {
                type: 'album',
                group: g.music.group,
                lost: 'none',
                evidence: true,
            });
            const s = await series(sql, g.tv.group);
            const ids = [movie, extra, unknown, s.root, ...s.seasons, ...s.episodes, s.extra];
            const snapshot = async (): Promise<unknown> => ({
                rows: await sql`SELECT * FROM media_items WHERE id = ANY(${ids}::uuid[]) ORDER BY id`,
                total: (await sql`SELECT COUNT(*)::int AS n FROM media_items`)[0].n,
            });
            const before = await snapshot();
            const preview = await unavailableMediaRetentionTask.execute({
                sql,
                input: { dryRun: true, batchLimit: 1000 },
                signal: new AbortController().signal,
                logger: { info: vi.fn() },
            } as unknown as Parameters<typeof unavailableMediaRetentionTask.execute>[0]);
            expect(preview.itemsProcessed).toBe(0);
            expect(preview.result).toMatchObject({ deleted: 0, initialized: 0, dryRun: true });
            expect(await snapshot()).toEqual(before);
            const actual = await run(sql);
            expect(actual.eligible).toBe(preview.result!.eligible);
            expect(actual.unknownAge).toBe(preview.result!.unknownAge);
            expect(actual.deletedIds).toEqual(expect.arrayContaining([movie, s.root]));
            expect(await exists(sql, ids)).toEqual([unknown]);
        });
    });

    // ---------------------------------------------------------------------
    // Protection
    // ---------------------------------------------------------------------

    const referenceCases: {
        name: string;
        table: string;
        key: string;
        insert: (sql: postgres.Sql, id: string, user: string) => Promise<unknown>;
    }[] = [
        {
            name: 'rating',
            table: 'user_ratings',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${id},${u},5)`,
        },
        {
            name: 'favorite state',
            table: 'user_media_state',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${id},${u},true)`,
        },
        {
            name: 'hot event',
            table: 'user_media_events',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_media_events (media_id,user_id,event_type,source,occurred_at) VALUES (${id},${u},'progress','lumastra-player',NOW())`,
        },
        {
            name: 'archived event',
            table: 'user_media_events_archive',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_media_events_archive (id,media_id,user_id,event_type,source,occurred_at,recorded_at) VALUES (${crypto.randomUUID()},${id},${u},'progress','lumastra-player',NOW(),NOW())`,
        },
        {
            name: 'music aggregate',
            table: 'user_music_state',
            key: 'track_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_music_state (track_id,user_id) VALUES (${id},${u})`,
        },
        {
            name: 'listening event',
            table: 'music_listen_events',
            key: 'track_id',
            insert: (s, id, u) =>
                s`INSERT INTO music_listen_events (track_id,user_id) VALUES (${id},${u})`,
        },
        {
            name: 'watch history',
            table: 'watch_history',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO watch_history (media_id,user_id,media_type,session_start_time) VALUES (${id},${u},'track',NOW())`,
        },
        {
            name: 'play session',
            table: 'play_sessions',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO play_sessions (media_id,user_id,device_id,ip_address,play_method) VALUES (${id},${u},'test','127.0.0.1','audio_only')`,
        },
        {
            name: 'comment',
            table: 'interactions',
            key: 'target_id',
            insert: (s, id, u) =>
                insertComment(s, { targetId: id, targetType: 'media', userId: u, body: 'keep' }),
        },
        {
            name: 'reaction',
            table: 'interaction_reactions',
            key: 'target_id',
            insert: (s, id, u) =>
                upsertReaction(s, { targetId: id, targetType: 'media', userId: u, emoji: 'heart' }),
        },
        {
            name: 'flag',
            table: 'user_media_flags',
            key: 'target_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_media_flags (target_id,target_type,user_id,flag_type) VALUES (${id},'track',${u},'featured_pick_shown')`,
        },
        {
            name: 'rate skip',
            table: 'user_rate_skips',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_rate_skips (media_id,user_id) VALUES (${id},${u})`,
        },
        {
            name: 'taste damper',
            table: 'user_taste_dampers',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_taste_dampers (media_id,user_id,media_type,expires_at) VALUES (${id},${u},'movie',NOW())`,
        },
        {
            name: 'share preference',
            table: 'user_media_share_opt_out',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_media_share_opt_out (media_id,user_id) VALUES (${id},${u})`,
        },
        {
            name: 'annotation',
            table: 'media_annotations',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO media_annotations (media_id,user_id,type,content) VALUES (${id},${u},'pin','keep')`,
        },
        {
            name: 'sync log',
            table: 'watch_state_sync_log',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO watch_state_sync_log (media_id,user_id,provider) VALUES (${id},${u},'jellyfin')`,
        },
        {
            name: 'sync activity',
            table: 'watch_sync_activity',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO watch_sync_activity (media_id,user_id,provider,direction,outcome) VALUES (${id},${u},'jellyfin','pull','success')`,
        },
        {
            name: 'pending sync resolution',
            table: 'watch_state_pending_resolution',
            key: 'internal_media_id',
            insert: (s, id, u) =>
                s`INSERT INTO watch_state_pending_resolution (internal_media_id,user_id,provider,media_type,provider_id) VALUES (${id},${u},'jellyfin','track',${id})`,
        },
        {
            name: 'watchlist activity',
            table: 'watchlist_activities',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO watchlist_activities (media_id,user_id,activity_type,tmdb_id,media_type,title) VALUES (${id},${u},'add',1,'track','keep')`,
        },
        {
            name: 'suggestion',
            table: 'user_suggestions',
            key: 'media_id',
            insert: (s, id, u) =>
                s`INSERT INTO user_suggestions (media_id,user_id) VALUES (${id},${u})`,
        },
        {
            name: 'external library availability',
            table: 'library_availability',
            key: 'media_id',
            insert: (s, id) =>
                s`INSERT INTO library_availability (media_id,library,library_item_id) VALUES (${id},'jellyfin','x')`,
        },
        {
            name: 'manual episode ordering',
            table: 'series_episode_ordering',
            key: 'media_id',
            insert: (s, id) =>
                s`INSERT INTO series_episode_ordering (media_id,ordering_type,ordering_source) VALUES (${id},'dvd','manual')`,
        },
        {
            name: 'playlist/watchlist',
            table: 'playlist_items',
            key: 'media_id',
            insert: async (s, id, u) => {
                const [p] = await s<
                    { id: number }[]
                >`INSERT INTO playlists (user_id,name) VALUES (${u},${'keep ' + id}) RETURNING id`;
                return s`INSERT INTO playlist_items (playlist_id,media_id,title,position) VALUES (${p.id},${id},'keep',0)`;
            },
        },
    ];

    it.each(referenceCases)(
        'retains $name and the referenced unit intact (track root and series member)',
        async ({ insert, table, key }) => {
            await inFixture(async (fx) => {
                const { sql: s, g, user } = fx;
                const album = await item(s, {
                    type: 'album',
                    group: g.music.group,
                    lost: 'recent',
                });
                const track = await item(s, { type: 'track', parent: album });
                const show = await series(s, g.tv.group);
                for (const id of [track, show.episodes[2]]) await insert(s, id, user);
                const refs = (): Promise<postgres.Row[]> =>
                    s`SELECT * FROM ${s(table)} WHERE ${s(key)}::text = ANY(${[track, show.episodes[2]]}::text[]) ORDER BY 1`;
                const before = await refs();
                expect(before.length).toBe(2);
                const candidates = await candidateIds(s, fx);
                expect(candidates).not.toContain(track);
                expect(candidates).not.toContain(show.root);
                const result = await run(s);
                expect(result.deletedIds).not.toContain(track);
                expect(result.deletedIds).not.toContain(show.root);
                expect(await exists(s, [track, show.root, ...show.episodes])).toHaveLength(5);
                expect(await refs()).toEqual(before);
            });
        },
    );

    it.each([
        { field: 'metadata_locked', value: true },
        { field: 'custom_poster_url', value: 'https://user.example/poster.jpg' },
        { field: 'custom_backdrop_url', value: 'https://user.example/backdrop.jpg' },
        { field: 'custom_logo_url', value: 'https://user.example/logo.jpg' },
        { field: 'custom_thumb_url', value: 'https://user.example/thumb.jpg' },
        { field: 'status', value: 'merged' },
    ])('a member with $field protects the whole unit', async ({ field, value }) => {
        await inFixture(async ({ sql, g }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            const extra = await item(sql, { type: 'extra', parent: movie, extraType: 'trailer' });
            await sql`UPDATE media_items SET ${sql(field)} = ${value} WHERE id = ${extra}`;
            const result = await run(sql);
            expect(result.deletedIds).not.toContain(movie);
            expect(await exists(sql, [movie, extra])).toHaveLength(2);
        });
    });

    it('operator dismissal protects; scanner dismissal does not', async () => {
        await inFixture(async ({ sql, g }) => {
            const operator = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                dismissed: 'operator',
            });
            const scanner = await item(sql, {
                type: 'movie',
                group: g.movie.group,
                dismissed: 'scanner',
            });
            const result = await run(sql);
            expect(result.deletedIds).toContain(scanner);
            expect(await exists(sql, [operator, scanner])).toEqual([operator]);
        });
    });

    it('uploaded artwork and inbound aliases protect; automatic local mirrors do not', async () => {
        await inFixture(async ({ sql, g }) => {
            const mirrored = await item(sql, { type: 'movie', group: g.movie.group });
            await sql`INSERT INTO media_artwork (media_item_id,artwork_type,source,remote_url,file_path)
                VALUES (${mirrored},'poster','local','provider:tmdb','/test/auto-poster.jpg')`;
            await sql`UPDATE media_items SET custom_poster_url=${'/api/image/custom/' + mirrored + '/poster'} WHERE id=${mirrored}`;
            const uploaded = await item(sql, { type: 'movie', group: g.movie.group });
            await sql`INSERT INTO media_artwork (media_item_id,artwork_type,source,remote_url,file_path)
                VALUES (${uploaded},'poster','local','admin:file','/test/upload.jpg')`;
            const aliased = await item(sql, { type: 'movie', group: g.movie.group });
            const alias = await item(sql, { type: 'movie', lost: 'none', group: null });
            await sql`UPDATE media_items SET canonical_id = ${aliased} WHERE id = ${alias}`;
            const result = await run(sql);
            expect(result.deletedIds).toContain(mirrored);
            expect(await exists(sql, [uploaded, aliased])).toHaveLength(2);
        });
    });

    it('transaction deadline unwinds an unwrapped slow query and releases fixture locks', async () => {
        const deadline = createLocalTestDeadline(3_000, 'transaction rollback regression');
        const observer = postgres(getTestDatabaseUrl(), { max: 1 });
        try {
            // Deliberately do not wrap pg_sleep with awaitQuery: the transaction-local
            // PostgreSQL 18 bound must cover arbitrary fixture callback queries too.
            await expect(
                inFixture(
                    async ({ sql }) => {
                        await sql`SELECT pg_sleep(10)`;
                    },
                    deadline,
                ),
            ).rejects.toThrow(/cancellation was awaited/i);
            expect(deadline.expired()).toBe(true);

            // addPath() inserted library_paths in the timed-out transaction. An
            // ACCESS EXCLUSIVE NOWAIT lock proves that its server-side rollback
            // completed and did not strand the relation lock.
            await observer.begin(async (sql) => {
                await sql`LOCK TABLE library_paths IN ACCESS EXCLUSIVE MODE NOWAIT`;
            });
        } finally {
            deadline.dispose();
            await observer.end();
        }
        });

    it('keeps a unit above the row cap and reports it', async () => {
        const label = 'unreferenced 5,002-row retention case';
        const startedAt = Date.now();
        const deadline = createLocalTestDeadline(50_000, label);
        try {
            await inFixture(async ({ sql, g }) => {
                const root = await item(sql, { type: 'tv', group: g.tv.group });
                const season = await item(sql, {
                    type: 'season',
                    parent: root,
                    season: 1,
                    lost: 'none',
                });
                const insert = sql`
                    INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, has_files)
                    SELECT 'ep ' || n, 'episode', ${season}, 1, n, false FROM generate_series(1, 5000) n
                `;
                await deadline.awaitQuery(insert, '5,000-episode fixture insert');
                deadline.assertRemaining();
                await assertNormalImageCapture(sql);
                expect(
                    await sql`SELECT COUNT(*)::int AS count FROM media_items WHERE parent_id=${season}`,
                ).toEqual([{ count: 5000 }]);
                const evaluationStartedAt = Date.now();
                await evaluateRetentionUnits(sql, { series: [g.tv.group] }, 1000, {
                    signal: deadline.signal,
                });
                console.info(
                    `[retention timing] ${label} evaluation: ${Date.now() - evaluationStartedAt}ms`,
                );
                const result = await run(sql, false, deadline.signal);
                expect(result.deletedIds).not.toContain(root);
                expect(result.byKind.series.oversized).toBeGreaterThanOrEqual(1);
                expect(await exists(sql, [root])).toEqual([root]);
                expect(
                    await sql`SELECT COUNT(*)::int AS count FROM media_items WHERE parent_id=${season}`,
                ).toEqual([{ count: 5000 }]);
            }, deadline);
            console.info(`[retention timing] ${label}: ${Date.now() - startedAt}ms`);
        } catch (error) {
            if (deadline.expired())
                throw new Error(
                    `${label} exceeded 50s; cancellation was awaited and its fixture rolled back`,
                    {
                        cause: error,
                    },
                );
            throw error;
        } finally {
            deadline.dispose();
        }
    });

    it('keeps an oversized referenced unit and reports its member eligibility as unassessed', async () => {
        const label = 'referenced 5,002-row retention case';
        const startedAt = Date.now();
        const deadline = createLocalTestDeadline(50_000, label);
        try {
            await inFixture(async ({ sql, g, user }) => {
                const root = await item(sql, { type: 'tv', group: g.tv.group });
                const season = await item(sql, {
                    type: 'season',
                    parent: root,
                    season: 1,
                    lost: 'none',
                });
                const insert = sql`
                    INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, has_files)
                    SELECT 'ep ' || n, 'episode', ${season}, 1, n, false FROM generate_series(1, 5000) n
                `;
                await deadline.awaitQuery(insert, '5,000-episode fixture insert');
                deadline.assertRemaining();
                await assertNormalImageCapture(sql);
                expect(
                    await sql`SELECT COUNT(*)::int AS count FROM media_items WHERE parent_id=${season}`,
                ).toEqual([{ count: 5000 }]);
                await sql`INSERT INTO interactions (target_type, target_id, user_id, body)
                    VALUES ('media', ${root}, ${user}, 'oversized retention reference')`;

                deadline.assertRemaining();
                const evaluationStartedAt = Date.now();
                await evaluateRetentionUnits(sql, { series: [g.tv.group] }, 1000, {
                    signal: deadline.signal,
                });
                console.info(
                    `[retention timing] ${label} evaluation: ${Date.now() - evaluationStartedAt}ms`,
                );
                const result = await run(sql, false, deadline.signal);

                expect(result.deletedIds).not.toContain(root);
                expect(result.byKind.series.oversized).toBeGreaterThanOrEqual(1);
                expect(result.byKind.series.protected).toBe(0);
                expect(await exists(sql, [root])).toEqual([root]);
                expect(
                    await sql`SELECT COUNT(*)::int AS count FROM media_items WHERE parent_id=${season}`,
                ).toEqual([{ count: 5000 }]);
                expect(
                    await sql`SELECT COUNT(*)::int AS count FROM interactions WHERE target_id = ${root}`,
                ).toMatchObject([{ count: 1 }]);

                // Shadow one reference source with a transaction-local trap.
                // The real evaluator must never evaluate member guards for the
                // over-cap root; a within-cap control must reach the trap.
                const small = await item(sql, { type: 'movie', group: g.movie.group });
                await sql`INSERT INTO user_ratings (user_id,media_id,rating) VALUES
                    (${user},${root},8),(${user},${small},8)`;
                await sql`CREATE FUNCTION pg_temp.retention_guard_probe() RETURNS boolean
                    LANGUAGE plpgsql VOLATILE AS $fn$
                    BEGIN RAISE EXCEPTION 'retention member guard executed'; END $fn$`;
                await sql`CREATE TEMP VIEW user_ratings AS
                    SELECT * FROM public.user_ratings WHERE pg_temp.retention_guard_probe()`;
                await evaluateRetentionUnits(sql, { series: [g.tv.group] }, 1000, {
                    rootId: root,
                    signal: deadline.signal,
                });
                await expect(
                    (sql as postgres.TransactionSql).savepoint(async (tx) =>
                        evaluateRetentionUnits(tx, { movie: [g.movie.group] }, 1000, {
                            rootId: small,
                        }),
                    ),
                ).rejects.toThrow('retention member guard executed');
            }, deadline);
            console.info(`[retention timing] ${label}: ${Date.now() - startedAt}ms`);
        } catch (error) {
            if (deadline.expired())
                throw new Error(
                    `${label} exceeded 50s; cancellation was awaited and its fixture rolled back`,
                    {
                        cause: error,
                    },
                );
            throw error;
        } finally {
            deadline.dispose();
        }
    });

    const legacyTargets = ['uppercase', 'dashless', 'uppercase-dashless'] as const;
    function legacyTarget(id: string, variant: string): string {
        const target = variant.includes('dashless') ? id.replace(/-/g, '') : id;
        return variant.includes('uppercase') ? target.toUpperCase() : target;
    }
    it.each(
        ['interactions', 'interaction_reactions', 'user_media_flags'].flatMap((table) =>
            legacyTargets.map((variant) => ({ table, variant })),
        ),
    )(
        'retains legacy $table references with $variant UUIDs on an episode',
        async ({ table, variant }) => {
            await inFixture(async ({ sql, g, user }) => {
                const s = await series(sql, g.tv.group);
                const target = legacyTarget(s.episodes[0], variant);
                if (table === 'interactions')
                    await sql`INSERT INTO interactions (target_type,target_id,user_id,body) VALUES ('media',${target},${user},'legacy comment')`;
                else if (table === 'interaction_reactions')
                    await sql`INSERT INTO interaction_reactions (target_type,target_id,user_id,emoji) VALUES ('media',${target},${user},'heart')`;
                else
                    await sql`INSERT INTO user_media_flags (target_type,target_id,user_id,flag_type) VALUES ('episode',${target},${user},'dismissed_cw')`;
                const before = await sql`SELECT * FROM ${sql(table)} WHERE target_id=${target}`;
                const result = await run(sql);
                expect(result.deletedIds).not.toContain(s.root);
                expect(await sql`SELECT * FROM ${sql(table)} WHERE target_id=${target}`).toEqual(
                    before,
                );
                expect(await exists(sql, [s.root, ...s.episodes])).toHaveLength(4);
            });
        },
    );

    it.each(['movie', 'series', 'tv', 'season', 'episode', 'audiobook', 'track', 'album'])(
        'setFlag on a %s target requires the media row and cannot orphan a flag',
        async (targetType) => {
            await inFixture(async ({ sql, user }) => {
                const missing = crypto.randomUUID();
                const written = await setFlag.execute(sql, {
                    userId: user as UserId,
                    targetType,
                    targetId: missing,
                    flagType: 'dismissed_cw',
                });
                expect(written).toEqual([]);
                const present = await item(sql, { type: 'movie', lost: 'none' });
                const ok = await setFlag.execute(sql, {
                    userId: user as UserId,
                    targetType,
                    targetId: present.toUpperCase(),
                    flagType: 'dismissed_cw',
                });
                expect(ok).toHaveLength(1);
            });
        },
    );

    // ---------------------------------------------------------------------
    // Legacy 30-day purge and other deletion paths
    // ---------------------------------------------------------------------

    it('the legacy purge leaves formerly-available, referenced, parent and credited rows alone', async () => {
        await inFixture(async ({ sql, user }) => {
            const deleted = async (o: Partial<ItemOpts> & { type: string }): Promise<string> => {
                return item(sql, { lost: 'none', status: 'deleted', staleUpdate: true, ...o });
            };
            const stub = await deleted({ type: 'movie' });
            const stubArtist = await deleted({ type: 'artist' });
            const formerlyOwned = await deleted({ type: 'movie', lost: 'old' });
            const evidenced = await deleted({ type: 'track', evidence: true });
            const referenced = await deleted({ type: 'movie' });
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${referenced},${user},4)`;
            const flagged = await deleted({ type: 'tv' });
            await sql`INSERT INTO user_media_flags (target_type,target_id,user_id,flag_type) VALUES ('series',${flagged.replace(/-/g, '')},${user},'series_excluded')`;
            const parent = await deleted({ type: 'tv' });
            await deleted({ type: 'season', parent, season: 1 });
            const credited = await deleted({ type: 'artist' });
            const legacyCredited = await deleted({ type: 'artist' });
            await item(sql, {
                type: 'track',
                lost: 'none',
                status: 'deleted',
                metadata: {
                    additional_artist_ids: [legacyCredited.replace(/-/g, '').toUpperCase()],
                },
            });
            // A non-array credit value holds no credits and must not break the purge.
            await item(sql, {
                type: 'track',
                lost: 'none',
                status: 'deleted',
                metadata: { additional_artist_ids: 'not-an-array' },
            });
            await item(sql, {
                type: 'track',
                lost: 'none',
                status: 'deleted',
                metadata: { additional_artist_ids: [credited] },
            });
            const cutoff = new Date(Date.now() - 30 * 86400000);
            const ids = await findHardDeletableMediaIds(sql, cutoff, 100_000);
            expect(ids).toEqual(expect.arrayContaining([stub, stubArtist]));
            for (const kept of [
                formerlyOwned,
                evidenced,
                referenced,
                flagged,
                parent,
                credited,
                legacyCredited,
            ])
                expect(ids).not.toContain(kept);
            expect(await isHardDeletableMediaId(sql, stub, cutoff)).toBe(true);
            expect(await isHardDeletableMediaId(sql, referenced, cutoff)).toBe(false);
            // A reference that appears after the snapshot is caught in the delete transaction.
            await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${stub},${user},true)`;
            const outcome = await MediaDeletionService.hardDelete(sql, stub, {
                guardFileBacked: true,
                eligibility: (tx) => isHardDeletableMediaId(tx, stub, cutoff),
            });
            expect(outcome).toMatchObject({ deleted: false, skipReason: 'eligibility-changed' });
            expect(await exists(sql, [stub, referenced])).toHaveLength(2);
            expect(
                (
                    await MediaDeletionService.hardDelete(sql, stubArtist, {
                        guardFileBacked: true,
                        eligibility: (tx) => isHardDeletableMediaId(tx, stubArtist, cutoff),
                    })
                ).deleted,
            ).toBe(true);
        });
    });

    it('an empty album with user references is not deleted by artist merges', async () => {
        await inFixture(async ({ sql, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const plain = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            const loved = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${loved},${user},true)`;
            expect(await deleteEmptyAlbum(sql, plain)).toBe(true);
            expect(await deleteEmptyAlbum(sql, loved)).toBe(false);
            expect(
                await sql`SELECT is_favorite FROM user_media_state WHERE media_id = ${loved}`,
            ).toEqual([{ is_favorite: true }]);
        });
    });

    it('an artist merge with a target album moves the references there and deletes the duplicate', async () => {
        await inFixture(async ({ sql, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const other = await item(sql, { type: 'artist', lost: 'none' });
            const target = await item(sql, { type: 'album', parent: other, lost: 'none' });
            const loved = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            const busy = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            await item(sql, { type: 'track', parent: busy, lost: 'none' });
            await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${loved},${user},true)`;
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${loved},${user},4)`;
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${busy},${user},2)`;

            expect(await deleteEmptyAlbum(sql, loved, target)).toBe(true);
            expect(await exists(sql, [loved])).toEqual([]);
            expect(
                await sql`SELECT media_id::text AS media_id, is_favorite FROM user_media_state WHERE user_id = ${user}`,
            ).toEqual([{ media_id: target, is_favorite: true }]);

            // An album that still has tracks keeps its own references.
            expect(await deleteEmptyAlbum(sql, busy, target)).toBe(false);
            expect(
                await sql`SELECT media_id::text AS media_id, rating::int AS rating FROM user_ratings
                    WHERE user_id = ${user} ORDER BY rating`,
            ).toEqual([
                { media_id: busy, rating: 2 },
                { media_id: target, rating: 4 },
            ]);
        });
    });

    it('an SQL error inside the reference move falls back to the soft delete and keeps the caller alive', async () => {
        await inFixture(async ({ sql, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const other = await item(sql, { type: 'artist', lost: 'none' });
            const target = await item(sql, { type: 'album', parent: other, lost: 'none' });
            const dup = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            // An index the move does not model: re-pointing the duplicate's
            // history row onto the target violates it (23505).
            await sql`CREATE UNIQUE INDEX merge_conflict_probe ON watch_history (media_id)
                WHERE media_type = 'merge-probe'`;
            for (const id of [target, dup])
                await sql`INSERT INTO watch_history (user_id, media_type, session_start_time, media_id)
                    VALUES (${user}, 'merge-probe', NOW(), ${id})`;
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${dup},${user},4)`;

            expect(await deleteEmptyAlbum(sql, dup, target)).toBe(false);

            // The caller's transaction is still usable and the partial move was rolled back.
            expect(
                await sql`SELECT status, has_files, parent_id::text AS parent_id FROM media_items WHERE id = ${dup}`,
            ).toEqual([{ status: 'deleted', has_files: false, parent_id: other }]);
            expect(
                await sql`SELECT media_id::text AS media_id FROM user_ratings WHERE user_id = ${user}`,
            ).toEqual([{ media_id: dup }]);
            expect(
                await sql`SELECT COUNT(*)::int AS n FROM watch_history WHERE media_id = ${dup}`,
            ).toEqual([{ n: 1 }]);
        });
    });

    it('an artist merge transfers uploaded artwork and favorites before deleting an unlocked duplicate', async () => {
        await inFixture(async ({ sql, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const other = await item(sql, { type: 'artist', lost: 'none' });
            const target = await item(sql, { type: 'album', parent: other, lost: 'none' });
            const duplicate = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            const [artwork] = await sql<{ id: string }[]>`
                INSERT INTO media_artwork (media_item_id, artwork_type, remote_url, file_path)
                VALUES (${duplicate}, 'poster', 'admin:upload', '/art/curated-album.jpg')
                RETURNING id
            `;
            const [candidate] = await sql<{ id: string }[]>`SELECT id FROM image_candidates
                WHERE media_item_id = ${duplicate} AND selected AND artwork_type = 'poster'`;
            expect(candidate.id).not.toBe(artwork.id);
            await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${duplicate},${user},true)`;

            expect(await deleteEmptyAlbum(sql, duplicate, target)).toBe(true);
            expect(await exists(sql, [duplicate, target])).toEqual([target]);
            expect(
                await sql`SELECT media_item_id::text AS media_item_id, artwork_type, remote_url, file_path
                    FROM image_candidates WHERE id = ${candidate.id}`,
            ).toEqual([
                {
                    media_item_id: target,
                    artwork_type: 'poster',
                    remote_url: 'admin:upload',
                    file_path: '/art/curated-album.jpg',
                },
            ]);
            expect(
                await sql`SELECT provider, provider_ref, locked, chosen_by FROM image_candidates
                WHERE id = ${candidate.id}`,
            ).toEqual([
                {
                    provider: 'upload',
                    provider_ref: '/art/curated-album.jpg',
                    locked: true,
                    chosen_by: 'admin',
                },
            ]);
            expect(
                await sql`SELECT file_path FROM media_artwork WHERE media_item_id = ${target}
                AND artwork_type = 'poster'`,
            ).toEqual([{ file_path: '/art/curated-album.jpg' }]);
            expect(
                await sql`SELECT media_id::text AS media_id, is_favorite FROM user_media_state WHERE user_id = ${user}`,
            ).toEqual([{ media_id: target, is_favorite: true }]);
        });
    });

    it('an artist merge falls back to the soft delete when the target is gone or the album metadata is locked', async () => {
        await inFixture(async ({ sql, user }) => {
            const artist = await item(sql, { type: 'artist', lost: 'none' });
            const other = await item(sql, { type: 'artist', lost: 'none' });
            const target = await item(sql, { type: 'album', parent: other, lost: 'none' });
            const row = async (id: string): Promise<unknown> =>
                (
                    await sql`SELECT status, has_files, parent_id::text AS parent_id
                        FROM media_items WHERE id = ${id}`
                )[0];

            // Target vanished: the move is refused, nothing moves, the album is soft-deleted.
            const orphan = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            await sql`INSERT INTO user_ratings (media_id,user_id,rating) VALUES (${orphan},${user},4)`;
            expect(await deleteEmptyAlbum(sql, orphan, crypto.randomUUID())).toBe(false);
            expect(await row(orphan)).toEqual({
                status: 'deleted',
                has_files: false,
                parent_id: artist,
            });
            expect(
                await sql`SELECT media_id::text AS media_id FROM user_ratings WHERE user_id = ${user}`,
            ).toEqual([{ media_id: orphan }]);
            await sql`DELETE FROM user_ratings WHERE user_id = ${user}`;

            // The album's own id in another spelling is no target at all.
            const self = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            expect(await deleteEmptyAlbum(sql, self, self.replace(/-/g, '').toUpperCase())).toBe(
                true,
            );

            // Locked metadata blocks the delete; artwork and references still move to the target.
            const curated = await item(sql, { type: 'album', parent: artist, lost: 'none' });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${curated}`;
            await sql`INSERT INTO media_artwork (media_item_id, artwork_type, remote_url)
                VALUES (${curated}, 'poster', 'admin:upload')`;
            await sql`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${curated},${user},true)`;
            expect(await deleteEmptyAlbum(sql, curated, target)).toBe(false);
            expect(await row(curated)).toEqual({
                status: 'deleted',
                has_files: false,
                parent_id: other,
            });
            expect(
                await sql`SELECT media_id::text AS media_id FROM user_media_state WHERE user_id = ${user}`,
            ).toEqual([{ media_id: target }]);
            expect(
                await sql`SELECT media_item_id::text AS media_item_id, remote_url FROM media_artwork
                    WHERE media_item_id IN (${curated}, ${target})`,
            ).toEqual([{ media_item_id: target, remote_url: 'admin:upload' }]);
        });
    });

    // ---------------------------------------------------------------------
    // Races (two connections)
    // ---------------------------------------------------------------------

    it.each(['flag', 'attachment', 'child', 'episode-reference'])(
        'two connections: an active %s writer wins and the in-transaction recheck keeps the unit',
        async (kind) => {
            const user = crypto.randomUUID(),
                group = crypto.randomUUID(),
                path = crypto.randomUUID(),
                history = crypto.randomUUID(),
                file = crypto.randomUUID(),
                root = crypto.randomUUID(),
                member = crypto.randomUUID(),
                season = crypto.randomUUID(),
                child = crypto.randomUUID();
            const isSeries = kind === 'episode-reference';
            let releaseWriter: () => void = () => {};
            let writerReady: () => void = () => {};
            const ready = new Promise<void>((resolve) => {
                writerReady = resolve;
            });
            const release = new Promise<void>((resolve) => {
                releaseWriter = resolve;
            });
            let pendingWriter: Promise<void> | undefined;
            try {
                await db`INSERT INTO users (id,username) VALUES (${user},${user})`;
                await db`INSERT INTO library_groups (id,name) VALUES (${group},${group})`;
                await db`INSERT INTO library_paths (id,path,media_type,provider,library_group_id,updated_at)
                    VALUES (${path},${'/lib/' + path},${isSeries ? 'tv' : 'movie'},'tmdb',${group},NOW()-INTERVAL '2 hours')`;
                await db`INSERT INTO task_history (id,task_id,label,state,input,trigger,actor,processing_version,started_at,completed_at,result)
                    VALUES (${history},'file-library-scan','race scan','completed',${db.json({ libraryPathId: path })},'{}','{}','1',NOW()-INTERVAL '1 hour',NOW(),${db.json(SCAN_OK)})`;
                await db`INSERT INTO media_items (id,title,media_type,status,has_files,files_lost_at,library_group_id)
                    VALUES (${root},'Race root',${isSeries ? 'tv' : 'movie'},'deleted',false,NOW()-INTERVAL '400 days',${group})`;
                if (isSeries) {
                    await db`INSERT INTO media_items (id,title,media_type,parent_id,season_number,has_files)
                        VALUES (${season},'Race season','season',${root},1,false)`;
                    await db`INSERT INTO media_items (id,title,media_type,parent_id,season_number,episode_number,has_files)
                        VALUES (${member},'Race episode','episode',${season},1,1,false)`;
                } else
                    await db`INSERT INTO media_items (id,title,media_type,parent_id,extra_type,has_files)
                        VALUES (${member},'Race extra','extra',${root},'trailer',false)`;
                const target: RetentionUnitCandidate = {
                    id: root,
                    kind: isSeries ? 'series' : 'movie',
                    group_key: group,
                    files_lost_at: new Date(0),
                };
                // Snapshot sees the candidate, then the other connection writes.
                const snapshot = await evaluateRetentionUnits(db, { [target.kind]: [group] }, 10, {
                    rootId: root,
                });
                expect(snapshot.candidates.map((c) => c.id)).toEqual([root]);
                pendingWriter = db.begin(async (raw) => {
                    const tx = raw as unknown as postgres.Sql;
                    if (kind === 'flag')
                        await setFlag.execute(tx, {
                            userId: user as UserId,
                            targetType: 'movie',
                            targetId: root,
                            flagType: 'dismissed_cw',
                        });
                    else if (kind === 'attachment') {
                        await tx`INSERT INTO media_files (id,file_path) VALUES (${file},${'/files/' + file})`;
                        await attachFileToItem(tx, file, member);
                    } else if (kind === 'child')
                        await tx`INSERT INTO media_items (id,title,media_type,parent_id,extra_type,has_files)
                            VALUES (${child},'Race new extra','extra',${root},'featurette',true)`;
                    else
                        await tx`INSERT INTO user_media_state (media_id,user_id,is_favorite) VALUES (${member},${user},true)`;
                    writerReady();
                    await release;
                }) as unknown as Promise<void>;
                await ready;
                await expect(
                    MediaDeletionService.retentionDeleteUnit(db, target),
                ).rejects.toMatchObject({ code: '55P03' });
                releaseWriter();
                await pendingWriter;
                const after = await MediaDeletionService.retentionDeleteUnit(db, target);
                expect(after.deleted).toBe(false);
                expect(await exists(db, [root, member])).toHaveLength(2);
            } finally {
                releaseWriter();
                if (pendingWriter) await pendingWriter;
                await db`DELETE FROM user_media_flags WHERE target_id = ${root}`;
                await db`DELETE FROM media_items WHERE id = ${child}`;
                await db`DELETE FROM media_items WHERE id = ${member}`;
                await db`DELETE FROM media_items WHERE id = ${season}`;
                await db`DELETE FROM media_items WHERE id = ${root}`;
                await db`DELETE FROM media_files WHERE id = ${file}`;
                await db`DELETE FROM task_history WHERE id = ${history}`;
                await db`DELETE FROM library_paths WHERE id = ${path}`;
                await db`DELETE FROM library_groups WHERE id = ${group}`;
                await db`DELETE FROM users WHERE id = ${user}`;
            }
        },
    );

    it('late polymorphic writes cannot reference a deleted unit', async () => {
        await inFixture(async ({ sql, g, user }) => {
            const movie = await item(sql, { type: 'movie', group: g.movie.group });
            expect(
                (
                    await MediaDeletionService.retentionDeleteUnit(sql, {
                        id: movie,
                        kind: 'movie',
                        group_key: g.movie.group,
                        files_lost_at: new Date(0),
                    })
                ).deleted,
            ).toBe(true);
            await upsertReaction(sql, {
                targetId: movie,
                targetType: 'media',
                userId: user,
                emoji: 'heart',
            });
            await setFlag.execute(sql, {
                userId: user as UserId,
                targetId: movie,
                targetType: 'movie',
                flagType: 'dismissed_cw',
            });
            expect(
                await sql`SELECT id FROM interaction_reactions WHERE target_id=${movie}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT id FROM user_media_flags WHERE target_id=${movie}`,
            ).toHaveLength(0);
        });
    });
});
