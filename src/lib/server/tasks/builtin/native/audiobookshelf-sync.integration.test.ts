// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `audiobookshelf-sync` — the task that fires the reconcile sweep.
 *
 * Covers the two things that are invisible from the outside and that both fail
 * as "the sync ran fine and did nothing":
 *
 *  1. The dynamic-schedule loader's gates and its interval bucket. A loader that
 *     returns nothing schedules nothing, with no error anywhere.
 *  2. That `execute()` reads settings under the MEDIA SOURCE's plugin id. Handing
 *     the task's own context to `scan()` type-checks perfectly and resolves
 *     `plugin_settings` under 'audiobookshelf-sync', which has no rows — so the
 *     operator's removal cap silently reverts to the default on every run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { upsertTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import {
    AUDIOBOOKSHELF_SOURCE_ID,
    SYNC_INTERVAL_MINUTES_KEY,
    DEFAULT_SYNC_INTERVAL_MINUTES,
    MIN_SYNC_INTERVAL_MINUTES,
    MAX_SYNC_INTERVAL_MINUTES,
    resolveSyncIntervalMinutes,
} from './media-sources/audiobookshelf.js';

const GROUP_ID = '00000000-0000-0000-0000-0000000abf00';
const PATH_ID = '00000000-0000-0000-0000-0000000abf01';
const PATH_ID_2 = '00000000-0000-0000-0000-0000000abf02';
const ABS_ITEM_ID = 'sync-test-book-1';

/**
 * ABS credentials must look present or every gate short-circuits.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above module-level `const`
 * declarations — a plain `const` here throws "Cannot access before
 * initialization" as soon as anything imports config at module scope, which the
 * ABS client does when it builds its singleton.
 */
const configMock = vi.hoisted(() => ({
    AUDIOURL: 'https://abs.test',
    AUDIOAPIKEY: 'k',
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        get config() {
            return { ...(actual.config as object), ...configMock };
        },
    };
});

describe('resolveSyncIntervalMinutes', () => {
    it('falls back to the default when unset', () => {
        expect(resolveSyncIntervalMinutes({})).toBe(DEFAULT_SYNC_INTERVAL_MINUTES);
    });

    it('accepts a plain number', () => {
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: 60 })).toBe(60);
    });

    it('accepts the STRING the admin settings form actually submits', () => {
        // The generic settings form posts numbers as strings. A
        // `typeof === 'number'` check alone reads every operator-set value as
        // absent and pins the default while the UI shows the new number.
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: '45' })).toBe(45);
    });

    it('clamps below the floor rather than hammering a full reconcile', () => {
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: 1 })).toBe(
            MIN_SYNC_INTERVAL_MINUTES,
        );
    });

    it('clamps above the ceiling', () => {
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: 99999 })).toBe(
            MAX_SYNC_INTERVAL_MINUTES,
        );
    });

    it('falls back on garbage instead of yielding NaN', () => {
        // A NaN interval makes the schedule bucket NaN, which dedups every run
        // away forever — silent total sync failure.
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: 'soon' })).toBe(
            DEFAULT_SYNC_INTERVAL_MINUTES,
        );
        expect(resolveSyncIntervalMinutes({ [SYNC_INTERVAL_MINUTES_KEY]: null })).toBe(
            DEFAULT_SYNC_INTERVAL_MINUTES,
        );
    });
});

describe('audiobookshelf-sync task', () => {
    let sql: postgres.Sql;
    let task: typeof import('./audiobookshelf-sync.js').audiobookshelfSyncTask;

    beforeAll(async () => {
        sql = await getTestDb();
        task = (await import('./audiobookshelf-sync.js')).audiobookshelfSyncTask;

        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${GROUP_ID}, 'Audiobooks (sync test)')
            ON CONFLICT (id) DO NOTHING
        `;
    });

    afterAll(async () => {
        await sql`DELETE FROM library_paths WHERE id = ${PATH_ID}`;
        await sql`DELETE FROM library_groups WHERE id = ${GROUP_ID}`;
        await sql`DELETE FROM plugin_settings WHERE plugin_id = ${AUDIOBOOKSHELF_SOURCE_ID}`;
        await sql`DELETE FROM task_history WHERE id LIKE 'run_dueness_%'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        configMock.AUDIOURL = 'https://abs.test';
        configMock.AUDIOAPIKEY = 'k';
        await sql`DELETE FROM library_paths WHERE id = ${PATH_ID}`;
        await sql`DELETE FROM plugin_settings WHERE plugin_id = ${AUDIOBOOKSHELF_SOURCE_ID}`;
        await sql`DELETE FROM task_history WHERE id LIKE 'run_dueness_%'`;
    });

    async function addAbsLibraryPath(): Promise<void> {
        await sql`
            INSERT INTO library_paths (id, path, media_type, language, provider, provider_path, library_group_id, enabled)
            VALUES (${PATH_ID}, 'abs://sync-test-lib', 'audiobook', 'de', 'audiobookshelf',
                    'sync-test-lib', ${GROUP_ID}, true)
        `;
    }

    /** A completed run of this task, so the loader's due-ness check sees history. */
    async function insertSyncRun(suffix: string, startedAt: Date): Promise<void> {
        await sql`
            INSERT INTO task_history (
                id, task_id, label, state, input, trigger, actor,
                started_at, completed_at, processing_version, stages
            ) VALUES (
                ${'run_dueness_' + suffix}, 'audiobookshelf-sync', 'AudiobookShelf Sync',
                'completed', '{}'::jsonb, '{"kind":"scheduled"}'::jsonb, '{}'::jsonb,
                ${startedAt}, ${startedAt}, '1', '[]'::jsonb
            )
        `;
    }

    function loaderCtx(now: Date) {
        return {
            sql,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
            signal: new AbortController().signal,
            now,
        };
    }

    /**
     * The loader's own parameter type, so the cast below stays honest: the test
     * builds only the four fields this loader reads, but the SDK context carries
     * host types (a real `Logger`) the test has no business constructing.
     * Deriving the type from the task rather than writing `any` means a loader
     * that starts reading a fifth field still type-checks here.
     */
    type LoaderCtx = Parameters<NonNullable<typeof task.dynamicSchedule>['loader']>[0];

    async function runLoader(now = new Date('2026-07-30T12:00:00Z')) {
        const loader = task.dynamicSchedule?.loader;
        if (!loader) throw new Error('task declares no dynamicSchedule.loader');
        return loader(loaderCtx(now) as unknown as LoaderCtx);
    }

    // -------------------------------------------------------------------
    // The total-failure guard. Injected sweep results, because what is under
    // test is the DECISION (throw vs report), not the sweep.
    // -------------------------------------------------------------------

    describe('total-failure guard', () => {
        const sweep = (over: Partial<Record<string, unknown>> = {}) => ({
            added: 0,
            updated: 0,
            removed: 0,
            unmatched: 0,
            skipped: 0,
            durationMs: 1,
            errors: [] as string[],
            ...over,
        });

        async function runExecute(sweepResult: ReturnType<typeof sweep>) {
            const source = await import('./media-sources/audiobookshelf.js');
            const scanSpy = vi
                .spyOn(source.audiobookshelfMediaSource, 'scan')
                .mockResolvedValue(sweepResult as never);
            try {
                const { buildPluginContext } = await import('../../plugin-context.js');
                const ctx = buildPluginContext(task.id, { sql });
                return await task.execute({ ...ctx, input: {} } as never);
            } finally {
                scanSpy.mockRestore();
            }
        }

        it('does NOT fail a settled library that verified books and hit one flaky fetch', async () => {
            // The ordinary shape at a 15-minute cadence: nothing changed, ~1200
            // books confirmed in sync, one expanded fetch flaked. Counting only
            // added/updated/removed makes this look like zero progress and fails
            // the run — feeding the circuit breaker on a healthy install.
            const result = await runExecute(
                sweep({ skipped: 1188, unmatched: 1, errors: ['could not fetch item x'] }),
            );

            expect(result.success).toBe(true);
            expect((result.result as Record<string, unknown>).errors).toEqual([
                'could not fetch item x',
            ]);
        });

        it('reports — not throws — when the dismissal rail trips', async () => {
            // The rail moves candidates to `skipped` and adds one error string.
            // Throwing here stores a null `result`, so the counters never land and
            // the admin page cannot render its "safety cap tripped" banner.
            const result = await runExecute(
                sweep({
                    skipped: 300,
                    errors: ['Library abs://x: dismissal threshold exceeded; nothing hidden'],
                }),
            );

            expect(result.success).toBe(true);
            const counters = result.result as Record<string, unknown>;
            expect(counters.dismissed).toBe(0);
            expect(counters.errors).toHaveLength(1);
        });

        it('still throws when nothing was verified and nothing progressed', async () => {
            // Zero on BOTH counters — an unreachable server, or every row lacking
            // provider_path. This must stay a failure or a broken sync reports
            // "completed" forever.
            await expect(
                runExecute(sweep({ errors: ['no provider_path; skipped', 'unreachable'] })),
            ).rejects.toThrow(/no progress/i);
        });

        it('does not throw on a clean no-op run with no errors', async () => {
            const result = await runExecute(sweep({ skipped: 42 }));
            expect(result.success).toBe(true);
        });

        it('reports real progress with its counters intact', async () => {
            const result = await runExecute(
                sweep({ added: 3, updated: 1, removed: 2, skipped: 10 }),
            );
            expect(result.success).toBe(true);
            expect(result.itemsProcessed).toBe(6);
        });

        it('records the per-library slices next to the run-wide counters', async () => {
            const libraries = {
                [PATH_ID]: {
                    listed: true,
                    added: 0,
                    updated: 0,
                    dismissed: 0,
                    unmatched: 0,
                    skipped: 40,
                    errors: 0,
                },
                'lp-broken': {
                    listed: false,
                    added: 0,
                    updated: 0,
                    dismissed: 0,
                    unmatched: 0,
                    skipped: 0,
                    errors: 1,
                },
            };
            const result = await runExecute(
                sweep({
                    skipped: 40,
                    errors: ['Library broken: upstream listing failed'],
                    libraries,
                }),
            );

            expect(result.success).toBe(true);
            expect(result.result).toEqual({
                added: 0,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 40,
                errors: ['Library broken: upstream listing failed'],
                libraries,
            });
        });

        it('keeps the old envelope shape when the sweep reports no libraries', async () => {
            const result = await runExecute(sweep({ skipped: 42 }));
            expect(result.result).not.toHaveProperty('libraries');
        });

        it('a real sweep whose only listing fails reports that library unlisted to the task', async () => {
            // End to end through the media source: scan() returns the
            // configured path unlisted with its listing error. The run itself
            // throws for making no progress, so nothing is stored.
            await addAbsLibraryPath();
            const { AudiobookshelfClient } = await import('$lib/server/audiobookshelf.js');
            const listSpy = vi
                .spyOn(AudiobookshelfClient.prototype, 'listAllLibraryItemsMinified')
                .mockResolvedValue({ ok: false, error: { kind: 'http', message: 'HTTP 500' } });
            const source = await import('./media-sources/audiobookshelf.js');
            const scanSpy = vi.spyOn(source.audiobookshelfMediaSource, 'scan');
            try {
                const { buildPluginContext } = await import('../../plugin-context.js');
                const ctx = buildPluginContext(task.id, { sql });
                await expect(task.execute({ ...ctx, input: {} } as never)).rejects.toThrow(
                    /no progress/i,
                );
                const scanned = await scanSpy.mock.results[0]?.value;
                if (!scanned || !source.hasSweepLibraries(scanned)) {
                    throw new Error('scan() returned no per-library results');
                }
                expect(scanned.libraries[PATH_ID]).toMatchObject({ listed: false, errors: 1 });
            } finally {
                scanSpy.mockRestore();
                listSpy.mockRestore();
            }
        });

        it('stores both libraries when one listing fails and the other succeeds', async () => {
            await addAbsLibraryPath();
            await sql`
                INSERT INTO library_paths (id, path, media_type, language, provider, provider_path, library_group_id, enabled)
                VALUES (${PATH_ID_2}, 'abs://sync-test-lib-2', 'audiobook', 'de', 'audiobookshelf',
                        'sync-test-lib-2', ${GROUP_ID}, true)
            `;
            // One book already in sync in the healthy library: verified, so skipped.
            const { createAudiobookSweepStore } =
                await import('./media-sources/_helpers/audiobookshelf/sweep-store.js');
            const bookId = await createAudiobookSweepStore(sql).insert(ABS_ITEM_ID, {
                title: 'Sync Test Book',
                sortTitle: 'sync test book',
                overview: null,
                year: null,
                runtimeSeconds: 60,
                hasFiles: true,
                libraryGroupId: GROUP_ID,
                libraryAddedAt: null,
                sortOrder: null,
                metadata: {
                    libraryId: 'sync-test-lib-2',
                    libraryPathId: PATH_ID_2,
                    updatedAt: 1_000,
                    mtimeMs: 2_000,
                    addedAt: null,
                    relPath: null,
                    coverPath: null,
                    subtitle: null,
                    authors: [],
                    narrators: [],
                    series: [],
                    derivedSeries: { name: null, sequence: null, source: 'none' },
                    genres: [],
                    publisher: null,
                    publishedYear: null,
                    language: null,
                    isbn: null,
                    asin: null,
                    explicit: false,
                    abridged: false,
                    duration: 60,
                    audioFiles: [],
                    chapters: [],
                },
            });
            const { AudiobookshelfClient } = await import('$lib/server/audiobookshelf.js');
            const listSpy = vi
                .spyOn(AudiobookshelfClient.prototype, 'listAllLibraryItemsMinified')
                .mockImplementation((libraryId) =>
                    Promise.resolve(
                        libraryId === 'sync-test-lib-2'
                            ? {
                                  ok: true,
                                  value: {
                                      libraryId,
                                      total: 1,
                                      pagesFetched: 1,
                                      items: [
                                          {
                                              id: ABS_ITEM_ID,
                                              libraryId,
                                              title: 'Sync Test Book',
                                              subtitle: null,
                                              authorName: null,
                                              narratorName: null,
                                              seriesName: null,
                                              publishedYear: null,
                                              coverPath: null,
                                              relPath: null,
                                              mediaType: 'book',
                                              duration: 60,
                                              numChapters: null,
                                              numAudioFiles: null,
                                              numFiles: null,
                                              size: null,
                                              mtimeMs: 2_000,
                                              addedAt: 0,
                                              updatedAt: 1_000,
                                              isMissing: false,
                                              isInvalid: false,
                                          },
                                      ],
                                  },
                              }
                            : { ok: false, error: { kind: 'http', message: 'HTTP 500' } },
                    ),
                );
            try {
                const { buildPluginContext } = await import('../../plugin-context.js');
                const ctx = buildPluginContext(task.id, { sql });
                const result = await task.execute({ ...ctx, input: {} } as never);

                expect(result.success).toBe(true);
                const libraries = (result.result as { libraries: Record<string, unknown> })
                    .libraries;
                expect(libraries[PATH_ID]).toMatchObject({ listed: false, errors: 1 });
                expect(libraries[PATH_ID_2]).toMatchObject({ listed: true, skipped: 1, errors: 0 });
            } finally {
                listSpy.mockRestore();
                await sql`DELETE FROM media_items WHERE id = ${bookId}`;
                await sql`DELETE FROM library_paths WHERE id = ${PATH_ID_2}`;
            }
        });
    });

    it('is registered as a real task, not just a media source', async () => {
        // The bug this whole task fixes: a media source is registered in a Map
        // nothing schedules from. Assert the definition is a task the
        // orchestrator can reach by id.
        const { registry } = await import('../../registry.js');
        expect(registry.getTask('audiobookshelf-sync')).toBeDefined();
        expect(registry.getTask('audiobookshelf-sync')?.id).toBe('audiobookshelf-sync');
    });

    it('schedules nothing when no audiobookshelf library exists', async () => {
        await expect(runLoader()).resolves.toEqual([]);
    });

    it('schedules nothing when credentials are absent', async () => {
        await addAbsLibraryPath();
        configMock.AUDIOAPIKEY = '';
        await expect(runLoader()).resolves.toEqual([]);
    });

    it('schedules nothing when the library row is disabled', async () => {
        await addAbsLibraryPath();
        await sql`UPDATE library_paths SET enabled = false WHERE id = ${PATH_ID}`;
        await expect(runLoader()).resolves.toEqual([]);
    });

    it('schedules one global entry once a library is configured', async () => {
        await addAbsLibraryPath();
        const entries = await runLoader();

        expect(entries).toHaveLength(1);
        expect(entries[0].rowId).toBe('all');
        expect(entries[0].input).toEqual({});
        expect(entries[0].bucket).toMatch(/^\d+$/);
    });

    describe('due-ness (the interval is enforced HERE, not by the bucket)', () => {
        // The scheduler consults this loader ~2x/minute and the shared
        // `rowId + bucket` idempotency key does NOT suppress repeat fires —
        // measured 12 attempts in 5m20s locally and 9 runs in ~10 minutes on
        // production against a 15-minute interval. Without the loader's own
        // check, the sweep re-pages the operator's entire AudiobookShelf library
        // every ~30 seconds.

        it('does NOT fire again while the interval has not elapsed', async () => {
            await addAbsLibraryPath();
            const now = new Date('2026-07-30T12:00:00Z');
            // Default interval 15 min; last run 2 minutes ago.
            await insertSyncRun('recent', new Date(now.getTime() - 2 * 60_000));

            await expect(runLoader(now)).resolves.toEqual([]);
        });

        it('fires once the interval HAS elapsed', async () => {
            await addAbsLibraryPath();
            const now = new Date('2026-07-30T12:00:00Z');
            await insertSyncRun('old', new Date(now.getTime() - 16 * 60_000));

            const entries = await runLoader(now);
            expect(entries).toHaveLength(1);
            expect(entries[0].rowId).toBe('all');
        });

        it('treats an in-flight run as suppressing, so sweeps cannot pile up', async () => {
            await addAbsLibraryPath();
            const now = new Date('2026-07-30T12:00:00Z');
            // started_at recent, never completed — a long sweep still running.
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, trigger, actor,
                    started_at, processing_version, stages
                ) VALUES (
                    'run_dueness_inflight', 'audiobookshelf-sync', 'AudiobookShelf Sync',
                    'active', '{}'::jsonb, '{"kind":"scheduled"}'::jsonb, '{}'::jsonb,
                    ${new Date(now.getTime() - 60_000)}, '1', '[]'::jsonb
                )
            `;

            await expect(runLoader(now)).resolves.toEqual([]);
        });

        it('fires on a first-ever sweep, when there is no history at all', async () => {
            await addAbsLibraryPath();
            const entries = await runLoader(new Date('2026-07-30T12:00:00Z'));
            expect(entries).toHaveLength(1);
        });

        it('honours the operator interval for due-ness, not just the default', async () => {
            await addAbsLibraryPath();
            await upsertTaskSettings(sql, AUDIOBOOKSHELF_SOURCE_ID, {
                [SYNC_INTERVAL_MINUTES_KEY]: 720,
            });
            const now = new Date('2026-07-30T12:00:00Z');
            // 30 minutes ago: due at the 15-minute default, NOT due at 720.
            await insertSyncRun('op', new Date(now.getTime() - 30 * 60_000));

            await expect(runLoader(now)).resolves.toEqual([]);
        });
    });

    it('resolves settings under the media source id, not the task id', async () => {
        await addAbsLibraryPath();

        // Written under the TASK id — where a naive `ctx` hand-off would look.
        await upsertTaskSettings(sql, 'audiobookshelf-sync', {
            [SYNC_INTERVAL_MINUTES_KEY]: 720,
        });

        try {
            // The loader must NOT see it: 12h apart stays two buckets at the
            // 15-minute default. If this passes with equal buckets, the task is
            // reading its own settings row and the operator's real settings
            // (stored under the media source id) are being ignored.
            const [a] = await runLoader(new Date('2026-07-30T00:05:00Z'));
            const [b] = await runLoader(new Date('2026-07-30T11:55:00Z'));
            expect(b.bucket).not.toBe(a.bucket);
        } finally {
            await sql`DELETE FROM plugin_settings WHERE plugin_id = 'audiobookshelf-sync'`;
        }
    });
});
