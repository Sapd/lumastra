// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for WatchSyncEngine
 *
 * Tests the public API (runPush, runPull) with mock SDK `WatchSyncDefinition`
 * plugins. Wave 6.5-C #2: ported from the legacy `WatchSyncPlugin` mocks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
    WatchSyncDefinition,
    WatchSyncResolveItem,
    WatchStateChange,
} from '@sapd/lumastra-plugin-sdk';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const {
    mockRegistry,
    mockSql,
    mockLogger,
    mockBatchGetStatesAll,
    mockGetStateOne,
    mockAppendEventAndRebuild,
    mockBuildPluginContext,
    mockListPreferences,
} = vi.hoisted(() => {
    // SQL mock returns unknown[] so tests can configure per-call payloads
    // (users table, external_ids, etc.) without fighting the type system.
    const mockSql = Object.assign(
        vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([])),
        {
            unsafe: vi.fn(),
            array: vi.fn((v: unknown) => v),
            begin: vi.fn(async (callback: (sql: unknown) => Promise<unknown>) => callback(mockSql)),
        },
    );

    return {
        mockRegistry: {
            getAllWatchSyncs: vi.fn(() => [] as WatchSyncDefinition[]),
        },
        mockSql,
        mockBatchGetStatesAll: vi.fn(async (sql: typeof mockSql) => sql()),
        mockGetStateOne: vi.fn(async (sql: typeof mockSql) => {
            const rows = await sql();
            return Array.isArray(rows) ? (rows[0] ?? null) : null;
        }),
        mockAppendEventAndRebuild: vi.fn(async () => undefined),
        // Defaults to "no rows" (every user falls back to direction:'both',
        // pushWatermark:null) — tests override per-case with mockResolvedValueOnce.
        mockListPreferences: vi.fn(
            async () => new Map<string, { direction: string; pushWatermark: Date | null }>(),
        ),
        mockLogger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        // The engine builds one PluginContext per push/pull-for-provider call
        // via buildPluginContext(pluginId). We return a minimal shim with the
        // fields the engine and plugins read off ctx — logger + signal.
        mockBuildPluginContext: vi.fn((_pluginId: string, opts?: { signal?: AbortSignal }) => ({
            sql: mockSql,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                debug: vi.fn(),
                child: vi.fn(),
            },
            signal: opts?.signal ?? new AbortController().signal,
            http: undefined,
            cache: undefined,
            settings: vi.fn(async () => ({})),
            secrets: {
                get: vi.fn(async () => ''),
                getOptional: vi.fn(async () => null),
                getUser: vi.fn(async () => ''),
            },
        })),
    };
});

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: mockRegistry,
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: mockBuildPluginContext,
}));

vi.mock('../database/connection.js', () => ({
    getTaskDb: vi.fn(() => mockSql),
}));

vi.mock('../database/queries/user-media-state.queries.js', () => ({
    batchGetStates: {
        all: mockBatchGetStatesAll,
    },
    getState: {
        one: mockGetStateOne,
    },
}));

vi.mock('./watch-state-rebuilder.service.js', () => ({
    appendEventAndRebuild: mockAppendEventAndRebuild,
}));

vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

vi.mock('../database/queries/watch-sync-preferences.queries.js', () => ({
    listPreferences: mockListPreferences,
}));

vi.mock('../database/queries/watch-sync-delivery.queries.js', () => ({
    deferSyncDelivery: vi.fn(async (_sql, _provider, _user, _events, reason: string) => ({
        firstReport: true,
        description: reason,
    })),
    getAcknowledgedJellyfinUnwatches: vi.fn(async () => new Map<string, string>()),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { watchSyncEngine } from './watch-sync-engine.service.js';
// NOT mocked — the real module's `.all()` builds a `sql\`...\`` template
// call against the (mocked) `mockSql`, exactly like every other query the
// engine issues. We spy on it (calling through) purely to capture the
// `userScopes`/params the engine passed, without disturbing the existing
// callIdx-based mockSql sequencing used throughout this file.
import { getUnpushedLumastraItems } from '../database/queries/user-media-events.queries.js';

// Spy once at module scope so the pass-through implementation (the real
// `.all()`, which issues its own `sql\`...\`` call against mockSql) is
// installed for the whole file. `vi.clearAllMocks()` in `beforeEach` only
// resets recorded calls, not this pass-through behaviour.
const unpushedItemsAllSpy = vi.spyOn(getUnpushedLumastraItems, 'all');

// ── Re-key fixtures ───────────────────────────────────────────────────────────
//
// Since mig 16.46.0 every user-data key is the stable users.id UUID. Push fixtures
// carry user_id as that UUID (the engine mints it via toUserId(item.user_id), so a
// username would throw). Pull fixtures carry the Jellyfin login name as
// providerUsername; the engine resolves it → users.id UUID via the (unmocked, real)
// resolveJellyfinNamesToUserIds, so the users-table SQL mocks must return rows
// shaped { id: <uuid>, jellyfin_name: <name> } / { username, jellyfin_name } — the
// new resolver contract — not the old username-only pre-filter shape.
const ALICE_UUID = '00000000-0000-0000-0000-0000000000a1';
const DENIS_UUID = '00000000-0000-0000-0000-0000000000de';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlugin(overrides: Partial<WatchSyncDefinition> = {}): WatchSyncDefinition {
    return {
        id: 'test-provider',
        name: 'Test Provider',
        version: '1.0.0',
        capabilities: { http: true },
        // Use a real provider substring so the EventSource validation
        // in pullForProvider maps cleanly. Synthetic names break the
        // hoisted check that protects against partial-commit pulls
        // on misconfigured plugins.
        providerName: 'Jellyfin',
        isAvailable: vi.fn(async () => true),
        resolveIds: vi.fn(async () => []),
        pushWatchState: vi.fn(async () => ({
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
        })),
        ...overrides,
    };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WatchSyncEngine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRegistry.getAllWatchSyncs.mockReturnValue([]);
        mockBatchGetStatesAll.mockImplementation(async (sql: typeof mockSql) => sql());
        mockGetStateOne.mockImplementation(async (sql: typeof mockSql) => {
            const rows = await sql();
            return Array.isArray(rows) ? (rows[0] ?? null) : null;
        });
        mockAppendEventAndRebuild.mockResolvedValue(undefined);
        mockListPreferences.mockResolvedValue(new Map());
    });

    // =========================================================================
    // runPush
    // =========================================================================

    describe('runPush', () => {
        it('returns empty array when no providers are registered', async () => {
            mockRegistry.getAllWatchSyncs.mockReturnValue([]);

            const results = await watchSyncEngine.runPush();

            expect(results).toEqual([]);
        });

        it('flags skippedUnavailable (not error) when provider is unavailable', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => false),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].providerId).toBe('test-provider');
            expect(results[0].skippedUnavailable).toBe(true);
            expect(results[0].errors).toHaveLength(0);
            expect(results[0].processed).toBe(0);
        });

        it('returns clean result when no un-pushed items exist', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            // Every SQL call (including getUnpushedLumastraItems) returns
            // empty → push loop exits on the first iteration.
            mockSql.mockResolvedValue([]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].providerId).toBe('test-provider');
            expect(results[0].skippedUnavailable).toBe(false);
            expect(results[0].processed).toBe(0);
            expect(results[0].errors).toHaveLength(0);
            expect(plugin.pushWatchState).not.toHaveBeenCalled();
        });

        it('skips plugins that do not implement pushWatchState', async () => {
            const plugin = makePlugin();
            // Force-remove pushWatchState (the type marks it required, so
            // we cast through Partial just for this regression-guard test).
            delete (plugin as Partial<WatchSyncDefinition>).pushWatchState;
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPush();

            // Plugin filtered out before pushForProvider is invoked.
            expect(results).toEqual([]);
        });

        it('drains a full page of terminal-skip items via plugin drainedAsSkipped (Fix 2)', async () => {
            // The plugin's resolveIds returns valid provider IDs (so the
            // engine builds a push batch), but pushWatchState reports
            // every item as terminally drained — e.g. the remote 404'd
            // for all items, or the user has no provider mapping. The
            // engine must mark the backing events pushed (via the
            // drainedAsSkipped path) so the next page read returns
            // different rows. Before Fix 2 this scenario relied on the
            // no-progress break to bail out; now drained items are
            // legitimately advanced.
            const PAGE_SIZE = 200;
            const items = Array.from({ length: PAGE_SIZE }, (_, i) => ({
                user_id: ALICE_UUID,
                media_id: `media-${i}`,
                event_ids: [`evt-${i}`],
                latest_decisive_event_type: 'mark_watched' as const,
            }));

            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                resolveIds: vi.fn(async (_ctx, resolveItems: WatchSyncResolveItem[]) =>
                    resolveItems.map((it) => ({
                        mediaId: it.mediaId,
                        providerId: `pv-${it.mediaId}`,
                    })),
                ),
                pushWatchState: vi.fn(async (_ctx, changes: WatchStateChange[]) => ({
                    succeeded: 0,
                    failed: 0,
                    skipped: changes.length,
                    staleIds: [],
                    errors: [],
                    successful: [],
                    drainedAsSkipped: changes.map((c) => ({
                        username: c.username,
                        mediaId: c.mediaId,
                    })),
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // First call returns the unpushed page; subsequent calls
            // (state hydration, metadata lookup, second-page read)
            // return empty. The second iteration's getUnpushedLumastraItems
            // returns empty so the loop terminates naturally.
            let callIdx = 0;
            mockSql.mockImplementation((strings?: unknown) => {
                callIdx++;
                // First call: getUnpushedLumastraItems → return the page.
                if (callIdx === 1) return Promise.resolve(items);
                // Second call: batchGetStates — return states for every
                // (user, media) so the engine builds a full push batch.
                if (callIdx === 2) {
                    return Promise.resolve(
                        items.map((it) => ({
                            user_id: it.user_id,
                            media_id: it.media_id,
                            is_watched: true,
                            resume_position_ms: 0,
                            runtime_ms: 5400000,
                            watch_count: 1,
                            first_watched_at: null,
                            last_watched_at: null,
                            last_event_at: null,
                            last_event_source: null,
                        })),
                    );
                }
                // Third call: media metadata WITH-CTE — return rows so
                // resolveItems is non-empty.
                if (callIdx === 3) {
                    return Promise.resolve(
                        items.map((it) => ({
                            id: it.media_id,
                            media_type: 'movie',
                            season_number: null,
                            episode_number: null,
                            parent_id: null,
                            title: 'X',
                            tmdb_id: '1',
                            imdb_id: null,
                            series_tmdb_id: null,
                        })),
                    );
                }
                // All subsequent calls (markEventsPushed UPDATEs and the
                // next-page getUnpushedLumastraItems) return empty.
                // Strings parameter is unused; suppress the warning.
                void strings;
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            // Plugin was called with the full set of changes.
            expect(plugin.pushWatchState).toHaveBeenCalledTimes(1);
            // Every item drained terminally — engine reported as skipped.
            expect(results[0].succeeded).toBe(0);
            expect(results[0].skipped).toBe(PAGE_SIZE);
            expect(results[0].failed).toBe(0);
            // Forward progress was made (drainedAsSkipped marked events
            // pushed) so the no-progress break MUST NOT fire.
            expect(mockLogger.warn).not.toHaveBeenCalledWith(
                expect.stringContaining('no progress made'),
                expect.anything(),
            );
        });

        it('does not reattempt a transient-only page within one run', async () => {
            // No items drained terminally and none succeeded — the plugin
            // reports every item as failed (network blip / 5xx). No events
            // get marked pushed. Exclusions allow later pages to proceed;
            // this mocked queue has no later items.
            const PAGE_SIZE = 200;
            const items = Array.from({ length: PAGE_SIZE }, (_, i) => ({
                user_id: ALICE_UUID,
                media_id: `media-${i}`,
                event_ids: [`evt-${i}`],
                latest_decisive_event_type: 'mark_watched' as const,
            }));

            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                resolveIds: vi.fn(async (_ctx, resolveItems: WatchSyncResolveItem[]) =>
                    resolveItems.map((it) => ({
                        mediaId: it.mediaId,
                        providerId: `pv-${it.mediaId}`,
                    })),
                ),
                pushWatchState: vi.fn(async (_ctx, changes: WatchStateChange[]) => ({
                    succeeded: 0,
                    failed: changes.length,
                    skipped: 0,
                    staleIds: [],
                    errors: ['network blip'],
                    successful: [],
                    drainedAsSkipped: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            let callIdx = 0;
            mockSql.mockImplementation(() => {
                callIdx++;
                if (callIdx === 1) return Promise.resolve(items);
                if (callIdx === 2) {
                    return Promise.resolve(
                        items.map((it) => ({
                            user_id: it.user_id,
                            media_id: it.media_id,
                            is_watched: true,
                            resume_position_ms: 0,
                            runtime_ms: 5400000,
                            watch_count: 1,
                            first_watched_at: null,
                            last_watched_at: null,
                            last_event_at: null,
                            last_event_source: null,
                        })),
                    );
                }
                if (callIdx === 3) {
                    return Promise.resolve(
                        items.map((it) => ({
                            id: it.media_id,
                            media_type: 'movie',
                            season_number: null,
                            episode_number: null,
                            parent_id: null,
                            title: 'X',
                            tmdb_id: '1',
                            imdb_id: null,
                            series_tmdb_id: null,
                        })),
                    );
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].succeeded).toBe(0);
            expect(results[0].failed).toBe(PAGE_SIZE);
            expect(results[0].skipped).toBe(0);
            // The engine reports the retained page without retrying it.
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('no progress made'),
                expect.objectContaining({
                    providerId: 'test-provider',
                    pageSize: PAGE_SIZE,
                }),
            );
        });

        it('retains progress-only items without a state row and reports why', async () => {
            // Five position-only items with unavailable derived state stay
            // queued, each with a reason. No watched-state call is allowed.
            const items = Array.from({ length: 5 }, (_, i) => ({
                user_id: ALICE_UUID,
                media_id: `media-${i}`,
                event_ids: [`evt-${i}-a`, `evt-${i}-b`],
                latest_decisive_event_type: null,
            }));

            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                resolveIds: vi.fn(async () => []),
                pushWatchState: vi.fn(async () => ({
                    succeeded: 0,
                    failed: 0,
                    skipped: 0,
                    staleIds: [],
                    errors: [],
                    successful: [],
                    drainedAsSkipped: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            let callIdx = 0;
            mockSql.mockImplementation(() => {
                callIdx++;
                // First call: getUnpushedLumastraItems.
                if (callIdx === 1) return Promise.resolve(items);
                // All following calls (markEventsPushed UPDATEs, next-
                // page read) return empty — second page is empty so the
                // loop terminates.
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPush();

            // Plugin's pushWatchState NEVER called — progress-only
            // queue must not influence remote state.
            expect(plugin.pushWatchState).not.toHaveBeenCalled();
            expect(plugin.resolveIds).not.toHaveBeenCalled();
            expect(results).toHaveLength(1);
            expect(results[0].skipped).toBe(5);
            expect(results[0].errors).toHaveLength(5);
            expect(results[0].errors[0]).toContain('derived state unavailable; retained for retry');
            expect(results[0].succeeded).toBe(0);
            expect(results[0].failed).toBe(0);
        });

        it('retains progress-only skips while delivering decisive pushes in one page', async () => {
            // Page contains 2 progress-only items (retained for retry) and
            // 1 decisive item (passed to the plugin). Plugin must receive
            // exactly the decisive item, and the page result must reflect
            // both paths.
            const items = [
                {
                    user_id: ALICE_UUID,
                    media_id: 'progress-only-1',
                    event_ids: ['evt-p1'],
                    latest_decisive_event_type: null,
                },
                {
                    user_id: ALICE_UUID,
                    media_id: 'progress-only-2',
                    event_ids: ['evt-p2'],
                    latest_decisive_event_type: null,
                },
                {
                    user_id: ALICE_UUID,
                    media_id: 'decisive-1',
                    event_ids: ['evt-d1'],
                    latest_decisive_event_type: 'mark_watched' as const,
                },
            ];

            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                resolveIds: vi.fn(async (_ctx, resolveItems: WatchSyncResolveItem[]) =>
                    resolveItems.map((it) => ({
                        mediaId: it.mediaId,
                        providerId: `pv-${it.mediaId}`,
                    })),
                ),
                pushWatchState: vi.fn(async (_ctx, changes: WatchStateChange[]) => ({
                    succeeded: changes.length,
                    failed: 0,
                    skipped: 0,
                    staleIds: [],
                    errors: [],
                    successful: changes.map((c) => ({
                        username: c.username,
                        mediaId: c.mediaId,
                    })),
                    drainedAsSkipped: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // Shared state/metadata hydration precedes both dispatch lanes.
            let callIdx = 0;
            mockSql.mockImplementation(() => {
                callIdx++;
                if (callIdx === 1) return Promise.resolve(items);
                if (callIdx === 2) {
                    return Promise.resolve([
                        {
                            user_id: ALICE_UUID,
                            media_id: 'decisive-1',
                            is_watched: true,
                            resume_position_ms: 0,
                            runtime_ms: 5400000,
                            watch_count: 1,
                            first_watched_at: null,
                            last_watched_at: null,
                            last_event_at: null,
                            last_event_source: null,
                        },
                    ]);
                }
                if (callIdx === 3) {
                    return Promise.resolve([
                        {
                            id: 'decisive-1',
                            media_type: 'movie',
                            season_number: null,
                            episode_number: null,
                            parent_id: null,
                            title: 'X',
                            tmdb_id: '1',
                            imdb_id: null,
                            series_tmdb_id: null,
                        },
                    ]);
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPush();

            // Plugin called once, with only the decisive item.
            expect(plugin.pushWatchState).toHaveBeenCalledTimes(1);
            // Args: (ctx, changes, signal) — changes is the 2nd arg.
            const callArg = (plugin.pushWatchState as ReturnType<typeof vi.fn>).mock
                .calls[0][1] as Array<{ mediaId: string }>;
            expect(callArg).toHaveLength(1);
            expect(callArg[0].mediaId).toBe('decisive-1');

            expect(results).toHaveLength(1);
            // Two progress-only skips + one decisive success = three processed.
            expect(results[0].succeeded).toBe(1);
            expect(results[0].skipped).toBe(2);
            expect(results[0].failed).toBe(0);
        });

        it('flags skippedUnavailable when DB is unavailable (Fix 7)', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // Simulate the DB-down path by rewiring getTaskDb to return null
            // for this test. The push engine must return a result with
            // skippedUnavailable=true and an error string explaining
            // the skip — not a hard provider-level failure.
            const { getTaskDb } = await import('../database/connection.js');
            const getTaskDbMock = vi.mocked(getTaskDb);
            getTaskDbMock.mockReturnValueOnce(null as unknown as ReturnType<typeof getTaskDb>);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].skippedUnavailable).toBe(true);
            // Error string is still surfaced (admin endpoint folds it
            // into the aggregated errors so success=false), but the
            // skippedUnavailable flag tells the UI it's transient.
            expect(results[0].errors).toEqual(
                expect.arrayContaining([expect.stringMatching(/Database unavailable/)]),
            );
        });
    });

    // =========================================================================
    // runPull
    // =========================================================================

    describe('runPull', () => {
        it('marks a rejected pull as not pulled so it cannot replace account notices', async () => {
            const plugin = makePlugin({
                pullWatchState: vi.fn(async () => {
                    throw new Error('Jellyfin /Users unavailable');
                }),
            });
            mockSql.mockResolvedValue([]);
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results[0]).toMatchObject({
                pulled: false,
                errors: ['Jellyfin /Users unavailable'],
            });
        });

        it('marks a successfully fetched empty pull as pulled', async () => {
            const plugin = makePlugin({
                pullWatchState: vi.fn(async () => ({
                    items: [],
                    errors: [],
                    skippedUsernames: [],
                })),
            });
            mockSql.mockResolvedValue([]);
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results[0]).toMatchObject({ pulled: true, errors: [] });
        });

        it('keeps account metadata from a pull that returned per-user errors', async () => {
            const plugin = makePlugin({
                pullWatchState: vi.fn(async () => ({
                    items: [],
                    errors: ['User alice: history unavailable'],
                    skippedUsernames: ['bob'],
                })),
            });
            mockSql.mockResolvedValue([]);
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results[0]).toMatchObject({
                pulled: true,
                skippedNoLumastraAccountNames: ['bob'],
                errors: ['User alice: history unavailable'],
            });
        });

        it('returns empty array when no providers are registered', async () => {
            mockRegistry.getAllWatchSyncs.mockReturnValue([]);

            const results = await watchSyncEngine.runPull();

            expect(results).toEqual([]);
        });

        it('returns empty array when no providers implement pullWatchState', async () => {
            const plugin = makePlugin();
            // pullWatchState is undefined by default in makePlugin
            delete (plugin as Partial<WatchSyncDefinition>).pullWatchState;
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results).toEqual([]);
        });

        it('flags skippedUnavailable (not error) when provider with pullWatchState is unavailable', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => false),
                pullWatchState: vi.fn(async () => ({ items: [], errors: [] })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].provider).toBe('test-provider');
            // S8: unavailable doesn't go into errors — admin UI reads the flag.
            expect(results[0].errors).toHaveLength(0);
            expect(results[0].skippedUnavailable).toBe(true);
            expect(results[0].totalUpserted).toBe(0);
        });

        it('returns pull result when provider returns items with no external_id match', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [
                        {
                            providerId: 'jf-123',
                            tmdbId: null,
                            imdbId: null,
                            mediaType: 'movie',
                            isWatched: true,
                            resumePositionMs: 0,
                            runtimeMs: 0,
                            watchCount: 1,
                            providerUsername: 'alice',
                        },
                    ],
                    errors: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // SQL call order in pullForProvider (Jellyfin provider):
            //   1. drainPendingResolution → loadPendingResolution SELECT
            //      (returns [] → empty buffer → drain returns early).
            //   2. cursor SELECT from watch_state_pull_log (returns [] →
            //      empty cursor map → full pull).
            //   3. getJellyfinUsernameMap → { username, jellyfin_name }.
            //   4. resolveJellyfinNamesToUserIds → { id (UUID), jellyfin_name }.
            //   5+. external_ids lookups (return [] → unmatched).
            // Calls 3 and 4 establish 'alice' as a known Lumastra user resolving
            // to a real users.id UUID so the pull proceeds past the filter; the
            // item still has no external_id match and gets skipped.
            let callCount = 0;
            mockSql.mockImplementation(() => {
                callCount++;
                if (callCount === 3) {
                    return Promise.resolve([{ username: 'alice', jellyfin_name: 'alice' }]);
                }
                if (callCount === 4) {
                    return Promise.resolve([{ id: ALICE_UUID, jellyfin_name: 'alice' }]);
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].provider).toBe('test-provider');
            // alice is a known Lumastra user, so usersSkippedNoLumastraAccount stays 0
            expect(results[0].usersSkippedNoLumastraAccount).toBe(0);
            // Item's provider ID not found in external_ids so it gets skipped
            expect(results[0].totalSkippedNoMatch).toBe(1);
            expect(results[0].totalUpserted).toBe(0);
        });

        it('skips Jellyfin-only users and surfaces usersSkippedNoLumastraAccount (R3-C4)', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [
                        {
                            providerId: 'jf-999',
                            tmdbId: null,
                            imdbId: null,
                            mediaType: 'movie',
                            isWatched: true,
                            resumePositionMs: 0,
                            runtimeMs: 0,
                            watchCount: 1,
                            providerUsername: 'bob-jellyfin-only',
                        },
                    ],
                    errors: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // users pre-filter returns empty → 'bob-jellyfin-only' is not a
            // Lumastra user → whole batch is dropped, counter bumps.
            mockSql.mockResolvedValue([]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].usersSkippedNoLumastraAccount).toBe(1);
            // No FK error should be raised — the batch never reaches upsert.
            expect(results[0].errors).toHaveLength(0);
            expect(results[0].totalUpserted).toBe(0);
        });

        it('counts and names Jellyfin users the plugin skipped before fetching (no items)', async () => {
            // The Jellyfin plugin drops accounts with no Lumastra match BEFORE
            // fetching their history, so they never appear in `items`. The plugin
            // reports them in `skippedUsernames`; the engine must count them.
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [],
                    errors: [],
                    skippedUsernames: ['bob-jellyfin-only', 'Carol-Jellyfin'],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].usersSkippedNoLumastraAccount).toBe(2);
            expect(results[0].skippedNoLumastraAccountNames).toEqual([
                'bob-jellyfin-only',
                'Carol-Jellyfin',
            ]);
            expect(results[0].errors).toHaveLength(0);
        });

        it('resolves a per-user plugin that emits the Lumastra UUID as providerUsername', async () => {
            // Per-user plugins (MAL, Trakt) key their credential store by the
            // Lumastra user UUID and emit that UUID as providerUsername (they have
            // no separate provider login name). The engine must index UUID→UUID so
            // the item is NOT dropped as "no matching Lumastra account". Before the
            // fix this pull skipped 1 user and imported nothing.
            const plugin = makePlugin({
                // Non-Jellyfin provider → exercises the else branch that indexes
                // UUIDs. 'trakt' maps to the trakt-sync EventSource so the pull
                // proceeds past the mapping guard.
                providerName: 'trakt',
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [
                        {
                            providerId: 'trakt-42',
                            tmdbId: null,
                            imdbId: null,
                            mediaType: 'movie',
                            isWatched: true,
                            resumePositionMs: 0,
                            runtimeMs: 0,
                            watchCount: 1,
                            // The credential-store key: the Lumastra user UUID.
                            providerUsername: DENIS_UUID,
                        },
                    ],
                    errors: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            // Non-Jellyfin SQL call order: 1. pending SELECT, 2. cursor SELECT,
            // 3. resolveUsernamesToUsers → { id (UUID), username }.
            // 'denis' resolves to DENIS_UUID; the engine also indexes DENIS_UUID
            // → itself, so the UUID providerUsername matches.
            let callCount = 0;
            mockSql.mockImplementation(() => {
                callCount++;
                if (callCount === 3) {
                    return Promise.resolve([{ id: DENIS_UUID, username: 'denis' }]);
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            // The UUID resolved → the user is NOT skipped (the bug this guards).
            expect(results[0].usersSkippedNoLumastraAccount).toBe(0);
            // Item reached resolution; no external_id match so it is buffered/skipped.
            expect(results[0].totalSkippedNoMatch).toBe(1);
        });

        it('resolves AudiobookShelf by Lumastra username despite a Jellyfin override', async () => {
            const plugin = makePlugin({
                providerName: 'audiobookshelf',
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [
                        {
                            providerId: 'abs-book',
                            tmdbId: null,
                            imdbId: null,
                            mediaType: 'audiobook',
                            isWatched: false,
                            resumePositionMs: 1_000,
                            runtimeMs: 10_000,
                            watchCount: 0,
                            providerUsername: 'Marc',
                        },
                    ],
                    errors: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            let callCount = 0;
            mockSql.mockImplementation(() => {
                callCount++;
                if (callCount === 3) {
                    return Promise.resolve([
                        {
                            id: DENIS_UUID,
                            username: 'Marc',
                            jellyfin_username: 'marc-jf',
                        },
                    ]);
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPull();

            expect(results[0].usersSkippedNoLumastraAccount).toBe(0);
            expect(results[0].totalSkippedNoMatch).toBe(1);
        });

        it('does not auto-complete active-session rewatches near EOF', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                pullWatchState: vi.fn(async () => ({
                    items: [
                        {
                            providerId: 'jf-ep-7',
                            tmdbId: null,
                            imdbId: null,
                            mediaType: 'episode',
                            isWatched: false,
                            isActiveSession: true,
                            resumePositionMs: 2_514_377,
                            runtimeMs: 2_584_608,
                            watchCount: 2,
                            providerUsername: 'Denis',
                            title: 'Die Ladung',
                        },
                    ],
                    errors: [],
                })),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockGetStateOne.mockResolvedValue({
                user_id: DENIS_UUID,
                media_id: 'episode-7-internal',
                is_watched: true,
                resume_position_ms: 0,
                runtime_ms: 2_584_608,
                watch_count: 2,
                first_watched_at: null,
                last_watched_at: null,
                last_event_at: null,
                last_event_source: 'jellyfin-sync',
                highest_session_elapsed_ms: null,
            });

            // SQL call order (Jellyfin provider):
            //   1. drainPendingResolution → loadPendingResolution SELECT
            //      (returns [] → empty buffer → drain returns early).
            //   2. cursor SELECT.
            //   3. getJellyfinUsernameMap → { username, jellyfin_name }.
            //   4. resolveJellyfinNamesToUserIds → { id (UUID), jellyfin_name } →
            //      'denis' resolves to DENIS_UUID, which keys all data writes.
            //   5. Strategy 2 provider-ID resolution external_ids lookup.
            //   6. batchGetStates.all() current-state read.
            let callCount = 0;
            mockSql.mockImplementation((strings?: unknown) => {
                // The pull path enriches resolved episodes with canonical
                // series/season/episode from the library. Return [] (no enrichment)
                // WITHOUT consuming a callCount slot, so this sequence-based mock
                // stays aligned.
                const q = Array.isArray(strings) ? strings.join(' ') : '';
                if (q.includes('series.title AS series_title')) return Promise.resolve([]);
                callCount++;
                if (callCount === 3) {
                    return Promise.resolve([{ username: 'denis', jellyfin_name: 'denis' }]);
                }
                if (callCount === 4) {
                    return Promise.resolve([{ id: DENIS_UUID, jellyfin_name: 'denis' }]);
                }
                if (callCount === 5) {
                    // Strategy 2 (provider-ID resolution) now selects mi.media_type
                    // and keys the resolution map by (external_id, media_type) so a
                    // provider ID reused across media types can't collide. The fixture
                    // must include media_type or the composite key won't match the
                    // item's 'episode' type and resolution silently drops it.
                    return Promise.resolve([
                        {
                            media_id: 'episode-7-internal',
                            external_id: 'jf-ep-7',
                            media_type: 'episode',
                        },
                    ]);
                }
                if (callCount === 6) {
                    // batchGetStates.all(): the pull path now reads current state
                    // via the batch query (not getState.one), so the existing
                    // is_watched=true row must come back here for the mark_unwatched
                    // + progress event pair to be emitted on the active-session
                    // rewatch.
                    return Promise.resolve([
                        {
                            user_id: DENIS_UUID,
                            media_id: 'episode-7-internal',
                            is_watched: true,
                            resume_position_ms: 0,
                            runtime_ms: 2_584_608,
                            watch_count: 2,
                            first_watched_at: null,
                            last_watched_at: null,
                            last_event_at: null,
                            last_event_source: 'jellyfin-sync',
                            highest_session_elapsed_ms: null,
                        },
                    ]);
                }
                return Promise.resolve([]);
            });

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].totalUpserted).toBe(1);
            expect(mockAppendEventAndRebuild).toHaveBeenCalledTimes(2);
            expect(mockAppendEventAndRebuild).toHaveBeenNthCalledWith(
                1,
                mockSql,
                expect.objectContaining({
                    user_id: DENIS_UUID,
                    media_id: 'episode-7-internal',
                    event_type: 'mark_unwatched',
                    source: 'jellyfin-sync',
                }),
            );
            expect(mockAppendEventAndRebuild).toHaveBeenNthCalledWith(
                2,
                mockSql,
                expect.objectContaining({
                    user_id: DENIS_UUID,
                    media_id: 'episode-7-internal',
                    event_type: 'progress',
                    position_ms: 2_514_377,
                    source: 'jellyfin-sync',
                }),
            );
            expect(mockAppendEventAndRebuild).not.toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    event_type: 'mark_watched',
                }),
            );
        });
    });

    // =========================================================================
    // Task 6: linked-users gate + direction enforcement
    // =========================================================================

    describe('push: linked-users gate + direction', () => {
        it('scopes the push queue to push-eligible linked users with their watermark', async () => {
            const u1Watermark = new Date('2026-01-01T00:00:00.000Z');
            mockListPreferences.mockResolvedValue(
                new Map([
                    ['u1', { direction: 'both', pushWatermark: u1Watermark }],
                    ['u2', { direction: 'push', pushWatermark: null }],
                    // pull-only — must be excluded from the push scope.
                    ['u3', { direction: 'pull', pushWatermark: null }],
                ]),
            );

            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1', 'u2', 'u3']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            // No un-pushed items → the page loop exits immediately after the
            // first (scoped) read; we only care about what it was called with.
            mockSql.mockResolvedValue([]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(unpushedItemsAllSpy).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    provider: 'jellyfin',
                    userScopes: expect.arrayContaining([
                        { userId: 'u1', since: u1Watermark },
                        { userId: 'u2', since: null },
                    ]),
                }),
            );
            const call = unpushedItemsAllSpy.mock.calls.at(-1);
            const passedScopes = (
                call?.[1] as { userScopes?: Array<{ userId: string; since: Date | null }> }
            ).userScopes;
            expect(passedScopes).toHaveLength(2);
            expect(passedScopes?.some((s) => s.userId === 'u3')).toBe(false);
        });

        it('dedupes duplicate linked userIds before building userScopes', async () => {
            mockListPreferences.mockResolvedValue(new Map());
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                // Same user reported twice — must collapse to one scope entry.
                listLinkedUsers: vi.fn(async () => ['u1', 'u1']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            await watchSyncEngine.runPush();

            const call = unpushedItemsAllSpy.mock.calls.at(-1);
            const passedScopes = (
                call?.[1] as { userScopes?: Array<{ userId: string; since: Date | null }> }
            ).userScopes;
            expect(passedScopes).toEqual([{ userId: 'u1', since: null }]);
        });

        it('passes no userScopes when listLinkedUsers returns null (Jellyfin, unchanged behavior)', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => null),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            await watchSyncEngine.runPush();

            expect(mockListPreferences).not.toHaveBeenCalled();
            const call = unpushedItemsAllSpy.mock.calls.at(-1);
            const passedParams = call?.[1] as { userScopes?: unknown };
            expect(passedParams.userScopes).toBeUndefined();
        });

        it('passes no userScopes when the plugin has no listLinkedUsers at all', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
            });
            delete (plugin as Partial<WatchSyncDefinition>).listLinkedUsers;
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            await watchSyncEngine.runPush();

            expect(mockListPreferences).not.toHaveBeenCalled();
            const call = unpushedItemsAllSpy.mock.calls.at(-1);
            const passedParams = call?.[1] as { userScopes?: unknown };
            expect(passedParams.userScopes).toBeUndefined();
        });

        it('keeps the audiobook push watermark on pull-only playback recovery', async () => {
            const watermark = new Date('2026-10-01T00:00:00Z');
            mockListPreferences.mockResolvedValue(
                new Map([['u1', { direction: 'pull', pushWatermark: watermark }]]),
            );
            const plugin = makePlugin({
                providerName: 'audiobookshelf',
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);
            await watchSyncEngine.runPush();
            expect(unpushedItemsAllSpy.mock.calls.at(-1)?.[1]).toMatchObject({
                userScopes: [{ userId: 'u1', since: watermark, playbackOnly: true }],
            });
        });

        it('short-circuits with no page reads when no linked user is push-eligible', async () => {
            mockListPreferences.mockResolvedValue(
                new Map([['u1', { direction: 'pull', pushWatermark: null }]]),
            );
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].processed).toBe(0);
            expect(results[0].errors).toHaveLength(0);
            // No page was ever read — the gate returned before the loop.
            expect(unpushedItemsAllSpy).not.toHaveBeenCalled();
        });

        it('degrades gracefully (does not throw, does not fall back to ungated push) when listLinkedUsers rejects', async () => {
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => {
                    throw new Error('provider API down');
                }),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            // A real gate failure must not surface as a hard provider
            // failure (result.errors) — it's a graceful skip-this-cycle,
            // logged as a warning instead.
            expect(results[0].errors).toHaveLength(0);
            expect(results[0].processed).toBe(0);
            // Never falls back to "no gating" — that would push ALL users.
            expect(unpushedItemsAllSpy).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('gate failed'),
                expect.objectContaining({ providerId: plugin.id }),
            );
        });

        it('degrades gracefully when listPreferences rejects after listLinkedUsers resolves', async () => {
            mockListPreferences.mockRejectedValueOnce(new Error('db unavailable'));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1', 'u2']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPush();

            expect(results).toHaveLength(1);
            expect(results[0].errors).toHaveLength(0);
            expect(unpushedItemsAllSpy).not.toHaveBeenCalled();
        });
    });

    describe('pull: linked-users gate + direction', () => {
        it('uses listPullUsers without widening the linked push audience', async () => {
            mockListPreferences.mockResolvedValue(
                new Map([
                    ['u1', { direction: 'both', pushWatermark: null }],
                    ['u2', { direction: 'pull', pushWatermark: null }],
                ]),
            );

            const listLinkedUsers = vi.fn(async () => ['push-linked-only']);
            const listPullUsers = vi.fn(async () => ['u1', 'u2']);
            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers,
                listPullUsers,
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            await watchSyncEngine.runPull();

            expect(listPullUsers).toHaveBeenCalledTimes(1);
            expect(listLinkedUsers).not.toHaveBeenCalled();
            const call = pullWatchState.mock.calls[0];
            const opts = (call! as unknown[])[1] as { onlyUserIds?: string[] };
            expect(opts.onlyUserIds).toEqual(['u1', 'u2']);
        });

        it('restricts the pull to both/pull-direction linked users via onlyUserIds', async () => {
            mockListPreferences.mockResolvedValue(
                new Map([
                    ['u1', { direction: 'both', pushWatermark: null }],
                    ['u2', { direction: 'pull', pushWatermark: null }],
                    // push-only — must be excluded from the pull scope.
                    ['u3', { direction: 'push', pushWatermark: null }],
                ]),
            );

            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1', 'u2', 'u3']),
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(pullWatchState).toHaveBeenCalledTimes(1);
            const call = pullWatchState.mock.calls[0];
            expect(call).toBeDefined();
            const opts = (call! as unknown[])[1] as { onlyUserIds?: string[] };
            expect(opts.onlyUserIds).toEqual(expect.arrayContaining(['u1', 'u2']));
            expect(opts.onlyUserIds).toHaveLength(2);
        });

        it('omits onlyUserIds when listLinkedUsers returns null (Jellyfin, unchanged behavior)', async () => {
            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => null),
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            await watchSyncEngine.runPull();

            expect(pullWatchState).toHaveBeenCalledTimes(1);
            const call = pullWatchState.mock.calls[0];
            expect(call).toBeDefined();
            const opts = (call! as unknown[])[1] as { onlyUserIds?: string[] };
            expect(opts.onlyUserIds).toBeUndefined();
        });

        it('degrades gracefully (does not throw, does not fall back to ungated pull) when listLinkedUsers rejects', async () => {
            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => {
                    throw new Error('provider API down');
                }),
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            // A real gate failure must not surface as a hard provider
            // failure (result.errors) — it's a graceful skip-this-cycle,
            // logged as a warning instead.
            expect(results[0].errors).toHaveLength(0);
            expect(results[0]).toMatchObject({ pulled: false });
            // Never falls back to "no gating" — that would pull for ALL
            // users instead of just the linked/eligible ones.
            expect(pullWatchState).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('gate failed'),
                expect.objectContaining({ providerId: plugin.id }),
            );
        });

        it('degrades gracefully when listPreferences rejects after listLinkedUsers resolves (pull side)', async () => {
            mockListPreferences.mockRejectedValueOnce(new Error('db unavailable'));
            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['u1', 'u2']),
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);

            const results = await watchSyncEngine.runPull();

            expect(results).toHaveLength(1);
            expect(results[0].errors).toHaveLength(0);
            expect(pullWatchState).not.toHaveBeenCalled();
        });
    });

    describe('runPushForUser / runPullForUser', () => {
        it('runPushForUser scopes the push to exactly the given user with no watermark floor', async () => {
            const plugin = makePlugin({
                id: 'test-provider',
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['someone-else']),
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            const reporter = vi.fn();
            await watchSyncEngine.runPushForUser('u1', 'test-provider', reporter);

            // The linked-users gate must be bypassed entirely for an explicit
            // per-user Export — listLinkedUsers/listPreferences are never consulted.
            expect(plugin.listLinkedUsers).not.toHaveBeenCalled();
            expect(mockListPreferences).not.toHaveBeenCalled();
            const call = unpushedItemsAllSpy.mock.calls.at(-1);
            const passedScopes = (
                call?.[1] as { userScopes?: Array<{ userId: string; since: Date | null }> }
            ).userScopes;
            expect(passedScopes).toEqual([{ userId: 'u1', since: null }]);
        });

        it('runPushForUser throws when the provider is not registered', async () => {
            mockRegistry.getAllWatchSyncs.mockReturnValue([]);

            await expect(
                watchSyncEngine.runPushForUser('u1', 'missing-provider', vi.fn()),
            ).rejects.toThrow(/missing-provider/);
        });

        it('runPullForUser restricts the pull to exactly the given user', async () => {
            const pullWatchState = vi.fn(async () => ({ items: [], errors: [] }));
            const plugin = makePlugin({
                id: 'test-provider',
                isAvailable: vi.fn(async () => true),
                listLinkedUsers: vi.fn(async () => ['someone-else']),
                pullWatchState,
            });
            mockRegistry.getAllWatchSyncs.mockReturnValue([plugin]);
            mockSql.mockResolvedValue([]);

            const reporter = vi.fn();
            await watchSyncEngine.runPullForUser('u1', 'test-provider', reporter);

            // The gate is bypassed for an explicit per-user Import too.
            expect(plugin.listLinkedUsers).not.toHaveBeenCalled();
            expect(mockListPreferences).not.toHaveBeenCalled();
            expect(pullWatchState).toHaveBeenCalledTimes(1);
            const call = pullWatchState.mock.calls[0];
            expect(call).toBeDefined();
            const opts = (call! as unknown[])[1] as { onlyUserIds?: string[] };
            expect(opts.onlyUserIds).toEqual(['u1']);
        });

        it('runPullForUser throws when the provider is not registered', async () => {
            mockRegistry.getAllWatchSyncs.mockReturnValue([]);

            await expect(
                watchSyncEngine.runPullForUser('u1', 'missing-provider', vi.fn()),
            ).rejects.toThrow(/missing-provider/);
        });
    });
});
