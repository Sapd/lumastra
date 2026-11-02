// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, type Mock } from 'vitest';
import type {
    AudiobookItemExpanded,
    AudiobookLibrarySnapshot,
    AudiobookItemMinified,
    AudiobookshelfErrorKind,
    AudiobookshelfResult,
} from '$lib/server/audiobookshelf.js';
import type {
    AudiobookFlagUpdate,
    AudiobookWriteParams,
    LocalAudiobookRow,
} from '$lib/server/database/queries/audiobooks.queries.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import {
    runAudiobookshelfSweep,
    buildAudiobookWriteParams,
    resolveDismissalRatio,
    DISMISS_MAX_PERCENT_KEY,
    type AudiobookSweepStore,
    type AudiobookshelfSweepSource,
    type SweepLogger,
} from './sweep.js';
import { DEFAULT_MAX_DISMISSAL_RATIO } from './sweep-diff.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function libraryPath(overrides: Partial<LibraryPathRow> = {}): LibraryPathRow {
    return {
        id: 'lp-1',
        path: 'abs://abs-lib-1',
        media_type: 'audiobook',
        language: 'de',
        provider: 'audiobookshelf',
        enabled: true,
        provider_path: 'abs-lib-1',
        library_group_id: 'group-hoerbuecher',
        edition_label: null,
        scan_chapters: false,
        fallback_providers: [],
        source_prefix: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        ...overrides,
    };
}

function minified(
    overrides: Partial<AudiobookItemMinified> & { id: string },
): AudiobookItemMinified {
    return {
        libraryId: 'abs-lib-1',
        title: `Title ${overrides.id}`,
        subtitle: null,
        authorName: null,
        narratorName: null,
        seriesName: null,
        publishedYear: null,
        coverPath: null,
        relPath: null,
        mediaType: 'book',
        duration: null,
        numChapters: null,
        numAudioFiles: null,
        numFiles: null,
        size: null,
        mtimeMs: 2_000,
        addedAt: 500,
        updatedAt: 1_000,
        isMissing: false,
        isInvalid: false,
        ...overrides,
    };
}

function snapshot(
    items: AudiobookItemMinified[],
    libraryId = 'abs-lib-1',
): AudiobookLibrarySnapshot {
    return { libraryId, items, total: items.length, pagesFetched: 1 };
}

function expanded(
    overrides: Partial<AudiobookItemExpanded> & { id: string },
): AudiobookItemExpanded {
    return {
        libraryId: 'abs-lib-1',
        folderId: null,
        path: null,
        relPath: `Autor/${overrides.id}`,
        mediaType: 'book',
        mtimeMs: 2_000,
        addedAt: 500,
        updatedAt: 1_000,
        isMissing: false,
        isInvalid: false,
        numFiles: 1,
        size: 123,
        ...overrides,
        media: {
            id: 'media-1',
            libraryItemId: overrides.id,
            coverPath: '/covers/1.jpg',
            tags: [],
            chapters: [],
            audioFiles: [],
            duration: 3600,
            size: 123,
            numTracks: 1,
            numAudioFiles: 1,
            ...overrides.media,
            metadata: {
                title: `Title ${overrides.id}`,
                titleIgnorePrefix: null,
                subtitle: null,
                authors: [],
                narrators: [],
                series: [],
                genres: [],
                publishedYear: null,
                publishedDate: null,
                publisher: null,
                description: null,
                isbn: null,
                asin: null,
                language: null,
                explicit: false,
                abridged: false,
                authorName: null,
                narratorName: null,
                seriesName: null,
                ...overrides.media?.metadata,
            },
        },
    };
}

function localRow(
    overrides: Partial<LocalAudiobookRow> & { absItemId: string },
): LocalAudiobookRow {
    return {
        mediaId: `media-${overrides.absItemId}`,
        status: 'active',
        libraryGroupId: 'group-hoerbuecher',
        hasFiles: true,
        isDismissed: false,
        absUpdatedAt: 1_000,
        absMtimeMs: 2_000,
        ...overrides,
    };
}

function err<T>(kind: AudiobookshelfErrorKind, message = 'boom'): AudiobookshelfResult<T> {
    return { ok: false, error: { kind, message } };
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface FakeStore extends AudiobookSweepStore {
    inserted: Array<{ absItemId: string; params: AudiobookWriteParams }>;
    updated: Array<{ mediaId: string; params: AudiobookWriteParams }>;
    flagCalls: Array<{ mediaIds: string[]; flags: AudiobookFlagUpdate }>;
    invalidated: string[][];
}

function makeStore(localByLibrary: Record<string, LocalAudiobookRow[]> = {}): FakeStore {
    const store: FakeStore = {
        inserted: [],
        updated: [],
        flagCalls: [],
        invalidated: [],
        listLocal: (absLibraryId) => Promise.resolve(localByLibrary[absLibraryId] ?? []),
        insert: (absItemId, params) => {
            store.inserted.push({ absItemId, params });
            return Promise.resolve(`new-media-${absItemId}`);
        },
        update: (mediaId, params) => {
            store.updated.push({ mediaId, params });
            return Promise.resolve();
        },
        setFlags: (mediaIds, flags) => {
            store.flagCalls.push({ mediaIds, flags });
            return Promise.resolve(mediaIds.length);
        },
        onContentChanged: (mediaIds) => {
            store.invalidated.push(mediaIds);
            return Promise.resolve();
        },
    };
    return store;
}

function makeSource(config: {
    snapshots?: Record<string, AudiobookshelfResult<AudiobookLibrarySnapshot>>;
    items?: Record<string, AudiobookshelfResult<AudiobookItemExpanded>>;
}): AudiobookshelfSweepSource & { listCalls: string[]; itemCalls: string[] } {
    const listCalls: string[] = [];
    const itemCalls: string[] = [];
    return {
        listCalls,
        itemCalls,
        listAllLibraryItemsMinified: (libraryId) => {
            listCalls.push(libraryId);
            return Promise.resolve(
                config.snapshots?.[libraryId] ?? { ok: true, value: snapshot([], libraryId) },
            );
        },
        getLibraryItemExpanded: (itemId) => {
            itemCalls.push(itemId);
            return Promise.resolve(
                config.items?.[itemId] ?? { ok: true, value: expanded({ id: itemId }) },
            );
        },
    };
}

type MockLogger = {
    [K in keyof SweepLogger]: Mock<SweepLogger[K]>;
};

function makeLogger(): MockLogger {
    return {
        info: vi.fn<SweepLogger['info']>(),
        warn: vi.fn<SweepLogger['warn']>(),
        error: vi.fn<SweepLogger['error']>(),
        debug: vi.fn<SweepLogger['debug']>(),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAudiobookshelfSweep — additions', () => {
    it('fetches the expanded item and inserts it with its ABS id', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([minified({ id: 'book-1' })]) } },
        });
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(source.itemCalls).toEqual(['book-1']);
        expect(store.inserted).toHaveLength(1);
        expect(store.inserted[0].absItemId).toBe('book-1');
        expect(store.inserted[0].params.libraryGroupId).toBe('group-hoerbuecher');
        expect(store.inserted[0].params.hasFiles).toBe(true);
        expect(store.inserted[0].params.metadata.libraryId).toBe('abs-lib-1');
        expect(store.inserted[0].params.metadata.libraryPathId).toBe('lp-1');
        expect(result).toMatchObject({ added: 1, updated: 0, removed: 0, unmatched: 0 });
        expect(result.errors).toEqual([]);
        expect(store.invalidated.flat()).toEqual(['new-media-book-1']);
    });

    it('inserts a missing-on-ABS book as unplayable rather than skipping it', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'book-1', isMissing: true })]),
                },
            },
            items: { 'book-1': { ok: true, value: expanded({ id: 'book-1', isMissing: true }) } },
        });
        const store = makeStore();

        await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.inserted[0].params.hasFiles).toBe(false);
    });

    it('counts an item whose expanded fetch 500s as unmatched and keeps going', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'bad' }), minified({ id: 'good' })]),
                },
            },
            items: { bad: err('http', 'HTTP error! status: 500') },
        });
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(result.added).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(store.inserted.map((i) => i.absItemId)).toEqual(['good']);
        expect(result.errors[0]).toContain('bad');
    });

    it('counts a failed insert as unmatched without aborting the library', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'a' }), minified({ id: 'b' })]),
                },
            },
        });
        const store = makeStore();
        store.insert = (absItemId) =>
            absItemId === 'a'
                ? Promise.reject(new Error('duplicate key'))
                : Promise.resolve('new-media-b');

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(result.added).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.errors.join('\n')).toContain('duplicate key');
    });
});

describe('runAudiobookshelfSweep — updates', () => {
    it('re-fetches and rewrites a book whose mtimeMs moved', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'book-1', mtimeMs: 9_999 })]),
                },
            },
            items: {
                'book-1': {
                    ok: true,
                    value: expanded({
                        id: 'book-1',
                        mtimeMs: 9_999,
                        media: {
                            ...expanded({ id: 'book-1' }).media,
                            chapters: [{ id: 0, start: 0, end: 60, title: 'Kapitel 1' }],
                        },
                    }),
                },
            },
        });
        const store = makeStore({ 'abs-lib-1': [localRow({ absItemId: 'book-1' })] });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.updated).toHaveLength(1);
        expect(store.updated[0].mediaId).toBe('media-book-1');
        // Chapters travel with the row rewrite — the "re-import chapters" rule.
        expect(store.updated[0].params.metadata.chapters).toEqual([
            { id: 0, start: 0, end: 60, title: 'Kapitel 1' },
        ]);
        // The revision stored is the one actually imported.
        expect(store.updated[0].params.metadata.mtimeMs).toBe(9_999);
        expect(result).toMatchObject({ added: 0, updated: 1, removed: 0 });
    });

    it('reattaches a re-added library even when ABS revisions did not change', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([minified({ id: 'book-1' })]) } },
        });
        const store = makeStore({
            'abs-lib-1': [
                localRow({
                    absItemId: 'book-1',
                    libraryPathId: 'removed-path',
                    isDismissed: true,
                    hasFiles: false,
                }),
            ],
        });
        await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });
        expect(store.updated).toHaveLength(1);
        expect(store.updated[0].params.metadata.libraryPathId).toBe(libraryPath().id);
    });

    it('toggles availability in a batch without any expanded fetch', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([
                        minified({ id: 'a', isMissing: true }),
                        minified({ id: 'b', isMissing: true }),
                    ]),
                },
            },
        });
        const store = makeStore({
            'abs-lib-1': [localRow({ absItemId: 'a' }), localRow({ absItemId: 'b' })],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(source.itemCalls).toEqual([]);
        expect(store.flagCalls).toEqual([
            { mediaIds: ['media-a', 'media-b'], flags: { hasFiles: false, isDismissed: false } },
        ]);
        expect(result.updated).toBe(2);
        // isMissing is availability, never removal.
        expect(result.removed).toBe(0);
    });

    it('does not write anything for a library that is already in sync', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([minified({ id: 'a' })]) } },
        });
        const store = makeStore({ 'abs-lib-1': [localRow({ absItemId: 'a' })] });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.inserted).toEqual([]);
        expect(store.updated).toEqual([]);
        expect(store.flagCalls).toEqual([]);
        expect(store.invalidated).toEqual([]);
        expect(result).toMatchObject({ added: 0, updated: 0, removed: 0, skipped: 1 });
    });
});

describe('runAudiobookshelfSweep — dismissals and rails', () => {
    it('dismissing sets has_files=false together with is_dismissed=true', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([minified({ id: 'kept' })]) } },
        });
        const store = makeStore({
            'abs-lib-1': [localRow({ absItemId: 'kept' }), localRow({ absItemId: 'gone' })],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
            // 1 of 2 is 50%; this test is about the write shape, not the cap.
            thresholds: { maxDismissalRatio: 1 },
        });

        expect(store.flagCalls).toEqual([
            { mediaIds: ['media-gone'], flags: { hasFiles: false, isDismissed: true } },
        ]);
        expect(result.removed).toBe(1);
    });

    it('never re-dismisses a book it already dismissed on an earlier cycle', async () => {
        // Dismissed rows stay in `listLocal` forever (the sweep must be able to
        // revive them), so re-counting them would rewrite long-gone rows every
        // 15 minutes, report them as freshly `removed`, and push each one
        // through cache invalidation on every run.
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([minified({ id: 'kept' })]) } },
        });
        const store = makeStore({
            'abs-lib-1': [
                localRow({ absItemId: 'kept' }),
                localRow({ absItemId: 'gone', isDismissed: true, hasFiles: false }),
            ],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.flagCalls).toEqual([]);
        expect(result.removed).toBe(0);
        expect(result.errors).toEqual([]);
        // Counted as skipped, not removed.
        expect(result.skipped).toBe(2);
    });

    it('RAIL 2 stays open once accumulated dismissals exceed the cap', async () => {
        // The ratchet: 20 books dismissed over past cycles (double the 10% cap)
        // would, if re-counted, return 'threshold-exceeded' on EVERY future run
        // — permanently freezing removals with no way for an operator to clear
        // it, and logging an error every 15 minutes.
        const present = Array.from({ length: 79 }, (_, i) => localRow({ absItemId: `here-${i}` }));
        const oldGone = Array.from({ length: 20 }, (_, i) =>
            localRow({ absItemId: `old-${i}`, isDismissed: true, hasFiles: false }),
        );
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot(present.map((row) => minified({ id: row.absItemId }))),
                },
            },
        });
        const store = makeStore({
            'abs-lib-1': [...present, localRow({ absItemId: 'newly-gone' }), ...oldGone],
        });
        const logger = makeLogger();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger,
            libraryPaths: [libraryPath()],
        });

        expect(store.flagCalls).toEqual([
            { mediaIds: ['media-newly-gone'], flags: { hasFiles: false, isDismissed: true } },
        ]);
        expect(result.removed).toBe(1);
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('RAIL 1: a failed listing skips the library entirely — no writes at all', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-1': err('http', 'HTTP error! status: 502') },
        });
        const store = makeStore({
            'abs-lib-1': [localRow({ absItemId: 'a' }), localRow({ absItemId: 'b' })],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.flagCalls).toEqual([]);
        expect(store.inserted).toEqual([]);
        expect(store.updated).toEqual([]);
        expect(result).toMatchObject({ added: 0, updated: 0, removed: 0 });
        expect(result.errors[0]).toContain('nothing was changed');
    });

    it('RAIL 2: an over-threshold dismissal aborts the pass and logs an error', async () => {
        const localRows = Array.from({ length: 100 }, (_, i) =>
            localRow({ absItemId: `book-${i}` }),
        );
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot(
                        localRows.slice(11).map((row) => minified({ id: row.absItemId })),
                    ),
                },
            },
        });
        const store = makeStore({ 'abs-lib-1': localRows });
        const logger = makeLogger();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger,
            libraryPaths: [libraryPath()],
        });

        expect(store.flagCalls).toEqual([]);
        expect(result.removed).toBe(0);
        expect(result.skipped).toBeGreaterThanOrEqual(11);
        expect(result.errors.join('\n')).toContain('Refusing to dismiss 11 of 100');
        expect(logger.error).toHaveBeenCalledWith(
            'Audiobookshelf sweep: dismissal threshold exceeded',
            expect.objectContaining({ candidates: 11, total: 100, allowed: 10 }),
        );
    });

    it('RAIL 2 does not block additions and updates in the same cycle', async () => {
        const localRows = Array.from({ length: 100 }, (_, i) =>
            localRow({ absItemId: `book-${i}` }),
        );
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([
                        ...localRows.slice(11).map((row) => minified({ id: row.absItemId })),
                        minified({ id: 'brand-new' }),
                    ]),
                },
            },
        });
        const store = makeStore({ 'abs-lib-1': localRows });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(store.inserted.map((i) => i.absItemId)).toEqual(['brand-new']);
        expect(result.added).toBe(1);
        expect(result.removed).toBe(0);
    });

    it('batches large dismissals across statements', async () => {
        const localRows = Array.from({ length: 1200 }, (_, i) =>
            localRow({ absItemId: `book-${i}` }),
        );
        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot([]) } },
        });
        const store = makeStore({ 'abs-lib-1': localRows });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
            thresholds: { maxDismissalRatio: 1 },
        });

        expect(store.flagCalls.map((c) => c.mediaIds.length)).toEqual([500, 500, 200]);
        expect(result.removed).toBe(1200);
    });
});

describe('runAudiobookshelfSweep — multi-library behaviour', () => {
    it('sweeps each library independently and does not cross-contaminate ids', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'de-1' })], 'abs-lib-1'),
                },
                'abs-lib-2': {
                    ok: true,
                    value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2'),
                },
            },
        });
        const store = makeStore({
            'abs-lib-1': [localRow({ absItemId: 'de-1' })],
            'abs-lib-2': [],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [
                libraryPath(),
                libraryPath({
                    id: 'lp-2',
                    provider_path: 'abs-lib-2',
                    path: 'abs://abs-lib-2',
                    language: 'en',
                }),
            ],
        });

        expect(source.listCalls).toEqual(['abs-lib-1', 'abs-lib-2']);
        expect(store.inserted.map((i) => i.absItemId)).toEqual(['en-1']);
        expect(store.flagCalls).toEqual([]);
        expect(result).toMatchObject({ added: 1, removed: 0 });
    });

    it('one library failing does not stop the others', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': err('http', 'HTTP error! status: 500'),
                'abs-lib-2': { ok: true, value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2') },
            },
        });
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [
                libraryPath(),
                libraryPath({ id: 'lp-2', provider_path: 'abs-lib-2', path: 'abs://abs-lib-2' }),
            ],
        });

        expect(result.added).toBe(1);
        expect(result.errors).toHaveLength(1);
    });

    it('stops the run when the server becomes unreachable', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': err('network', 'getaddrinfo ENOTFOUND abs.local'),
                'abs-lib-2': { ok: true, value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2') },
            },
        });
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [
                libraryPath(),
                libraryPath({ id: 'lp-2', provider_path: 'abs-lib-2', path: 'abs://abs-lib-2' }),
            ],
        });

        expect(source.listCalls).toEqual(['abs-lib-1']);
        expect(store.inserted).toEqual([]);
        expect(result.errors.join('\n')).toContain('became unreachable');
    });

    it('reports a library_paths row with no provider_path instead of sweeping nothing silently', async () => {
        const source = makeSource({});
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath({ provider_path: null })],
        });

        expect(source.listCalls).toEqual([]);
        expect(result.errors[0]).toContain('no provider_path');
    });

    it('refuses to sweep the same ABS library twice', async () => {
        const source = makeSource({});
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath(), libraryPath({ id: 'lp-dup' })],
        });

        expect(source.listCalls).toEqual(['abs-lib-1']);
        expect(result.errors.join('\n')).toContain('claimed by more than one');
    });

    it('an abort mid-update stops before the bulk dismissal write', async () => {
        const controller = new AbortController();
        const localRows = [
            localRow({ absItemId: 'edited', absUpdatedAt: 1 }),
            localRow({ absItemId: 'gone' }),
        ];
        const base = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot([minified({ id: 'edited', updatedAt: 2 })]),
                },
            },
        });
        // Cancel the run as soon as the first expanded fetch resolves.
        const source: AudiobookshelfSweepSource = {
            listAllLibraryItemsMinified: base.listAllLibraryItemsMinified,
            getLibraryItemExpanded: async (itemId) => {
                const value = await base.getLibraryItemExpanded(itemId);
                controller.abort();
                return value;
            },
        };
        const store = makeStore({ 'abs-lib-1': localRows });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
            signal: controller.signal,
            thresholds: { maxDismissalRatio: 1 },
        });

        // The one book it got to is written; the vanished book is NOT dismissed,
        // because a cancelled run must not perform a bulk availability write.
        expect(store.updated.map((u) => u.mediaId)).toEqual(['media-edited']);
        expect(store.flagCalls).toEqual([]);
        expect(result.removed).toBe(0);
        expect(result.errors.join('\n')).toContain('aborted');
    });

    it('honours an abort signal between libraries', async () => {
        const controller = new AbortController();
        controller.abort();
        const source = makeSource({});
        const store = makeStore();

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
            signal: controller.signal,
        });

        expect(source.listCalls).toEqual([]);
        expect(result.errors[0]).toContain('aborted');
    });

    it('caps the collected error list', async () => {
        const items = Array.from({ length: 60 }, (_, i) => minified({ id: `book-${i}` }));
        const failures: Record<string, AudiobookshelfResult<AudiobookItemExpanded>> = {};
        for (const item of items) failures[item.id] = err('malformed', 'no media object');

        const source = makeSource({
            snapshots: { 'abs-lib-1': { ok: true, value: snapshot(items) } },
            items: failures,
        });
        const result = await runAudiobookshelfSweep({
            source,
            store: makeStore(),
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(result.unmatched).toBe(60);
        expect(result.errors).toHaveLength(26);
        expect(result.errors[25]).toContain('further error(s) suppressed');
    });
});

describe('runAudiobookshelfSweep — per-library results', () => {
    const twoPaths = (): LibraryPathRow[] => [
        libraryPath(),
        libraryPath({ id: 'lp-2', provider_path: 'abs-lib-2', path: 'abs://abs-lib-2' }),
    ];

    it('splits counts per library and marks a failed listing unlisted', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': err('http', 'HTTP error! status: 500'),
                'abs-lib-2': {
                    ok: true,
                    value: snapshot(
                        [minified({ id: 'en-1' }), minified({ id: 'en-2' })],
                        'abs-lib-2',
                    ),
                },
            },
        });
        const store = makeStore({ 'abs-lib-2': [localRow({ absItemId: 'en-2' })] });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: twoPaths(),
        });

        expect(result.libraries).toEqual({
            'lp-1': {
                listed: false,
                added: 0,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 0,
                errors: 1,
            },
            'lp-2': {
                listed: true,
                added: 1,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 1,
                errors: 0,
            },
        });
        expect(result).toMatchObject({ added: 1, skipped: 1 });
        expect(result.errors).toHaveLength(1);
    });

    it('counts a tripped dismissal cap against its own library only', async () => {
        const localRows = Array.from({ length: 100 }, (_, i) =>
            localRow({ absItemId: `book-${i}` }),
        );
        const source = makeSource({
            snapshots: {
                'abs-lib-1': {
                    ok: true,
                    value: snapshot(
                        localRows.slice(11).map((row) => minified({ id: row.absItemId })),
                    ),
                },
                'abs-lib-2': {
                    ok: true,
                    value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2'),
                },
            },
        });
        const store = makeStore({
            'abs-lib-1': localRows,
            'abs-lib-2': [localRow({ absItemId: 'en-1' })],
        });

        const result = await runAudiobookshelfSweep({
            source,
            store,
            logger: makeLogger(),
            libraryPaths: twoPaths(),
        });

        expect(result.libraries['lp-1']).toMatchObject({
            listed: true,
            dismissed: 0,
            skipped: 100,
            errors: 1,
        });
        expect(result.libraries['lp-2']).toMatchObject({ listed: true, skipped: 1, errors: 0 });
        expect(result.skipped).toBe(101);
    });

    it('leaves the libraries after an unreachable server unlisted', async () => {
        const source = makeSource({
            snapshots: {
                'abs-lib-1': err('network', 'getaddrinfo ENOTFOUND abs.local'),
                'abs-lib-2': { ok: true, value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2') },
            },
        });

        const result = await runAudiobookshelfSweep({
            source,
            store: makeStore(),
            logger: makeLogger(),
            libraryPaths: twoPaths(),
        });

        expect(result.libraries['lp-1']).toMatchObject({ listed: false, errors: 1 });
        expect(result.libraries['lp-2']).toMatchObject({ listed: false, added: 0, errors: 0 });
    });

    it('counts a run-wide abort against the library that was already listed', async () => {
        const controller = new AbortController();
        const store = makeStore({ 'abs-lib-1': [localRow({ absItemId: 'gone' })] });
        const setFlags = store.setFlags;
        // The run is cancelled right as library 1 finishes its last write.
        store.setFlags = (ids, flags) => {
            controller.abort();
            return setFlags(ids, flags);
        };

        const result = await runAudiobookshelfSweep({
            source: makeSource({}),
            store,
            logger: makeLogger(),
            libraryPaths: twoPaths(),
            signal: controller.signal,
            thresholds: { maxDismissalRatio: 1 },
        });

        expect(result.errors.join('\n')).toContain('aborted before completing every library');
        expect(result.libraries['lp-1']).toMatchObject({ listed: true, dismissed: 1, errors: 1 });
        expect(result.libraries['lp-2']).toMatchObject({ listed: false, errors: 0 });
    });

    it('counts an unreachable server against the library that was already listed', async () => {
        const source = makeSource({
            snapshots: { 'abs-lib-2': err('network', 'getaddrinfo ENOTFOUND abs.local') },
        });

        const result = await runAudiobookshelfSweep({
            source,
            store: makeStore(),
            logger: makeLogger(),
            libraryPaths: twoPaths(),
        });

        expect(result.libraries['lp-1']).toMatchObject({ listed: true, errors: 1 });
        expect(result.libraries['lp-2']).toMatchObject({ listed: false, errors: 1 });
    });

    it.each(['update', 'setFlags'] as const)(
        'attributes a failed %s after a good listing to its own library',
        async (failing) => {
            const source = makeSource({
                snapshots: {
                    'abs-lib-1': {
                        ok: true,
                        value: snapshot([
                            failing === 'update'
                                ? minified({ id: 'book', updatedAt: 2 })
                                : minified({ id: 'book', isMissing: true }),
                        ]),
                    },
                    'abs-lib-2': {
                        ok: true,
                        value: snapshot([minified({ id: 'en-1' })], 'abs-lib-2'),
                    },
                },
            });
            const store = makeStore({
                'abs-lib-1': [
                    localRow({ absItemId: 'book', absUpdatedAt: failing === 'update' ? 1 : 1_000 }),
                ],
                'abs-lib-2': [localRow({ absItemId: 'en-1' })],
            });
            const reject = (): Promise<never> => Promise.reject(new Error('db down'));
            if (failing === 'update') store.update = reject;
            else store.setFlags = reject;

            const result = await runAudiobookshelfSweep({
                source,
                store,
                logger: makeLogger(),
                libraryPaths: twoPaths(),
            });

            expect(result.libraries['lp-1']).toMatchObject({ listed: true, errors: 1 });
            expect(result.libraries['lp-2']).toMatchObject({ listed: true, skipped: 1, errors: 0 });
        },
    );

    it('reports misconfigured and duplicate rows as unlisted with an error', async () => {
        const result = await runAudiobookshelfSweep({
            source: makeSource({}),
            store: makeStore(),
            logger: makeLogger(),
            libraryPaths: [
                libraryPath(),
                libraryPath({ id: 'lp-dup' }),
                libraryPath({ id: 'lp-bare', provider_path: null }),
            ],
        });

        expect(result.libraries['lp-1']).toMatchObject({ listed: true, errors: 0 });
        expect(result.libraries['lp-dup']).toMatchObject({ listed: false, errors: 1 });
        expect(result.libraries['lp-bare']).toMatchObject({ listed: false, errors: 1 });
    });

    it("keeps counting a library's errors past the run-wide string cap", async () => {
        const items = Array.from({ length: 60 }, (_, i) => minified({ id: `book-${i}` }));
        const failures: Record<string, AudiobookshelfResult<AudiobookItemExpanded>> = {};
        for (const item of items) failures[item.id] = err('malformed', 'no media object');

        const result = await runAudiobookshelfSweep({
            source: makeSource({
                snapshots: { 'abs-lib-1': { ok: true, value: snapshot(items) } },
                items: failures,
            }),
            store: makeStore(),
            logger: makeLogger(),
            libraryPaths: [libraryPath()],
        });

        expect(result.libraries['lp-1']).toMatchObject({ listed: true, unmatched: 60, errors: 60 });
    });
});

describe('buildAudiobookWriteParams', () => {
    it.each([null, '', 'ja'])(
        'does not assume English sorting for declared language %s',
        (language) => {
            const base = expanded({ id: 'mixed' });
            const params = buildAudiobookWriteParams({
                expanded: {
                    ...base,
                    media: {
                        ...base.media,
                        metadata: {
                            ...base.media.metadata,
                            title: 'The Glass Orchard',
                            language: 'en',
                        },
                    },
                },
                absLibraryId: 'l',
                libraryPathId: 'lp',
                libraryGroupId: 'g',
                language,
            });
            expect(params.sortTitle).toBe('the glass orchard');
        },
    );
    it('maps metadata, chapters and series onto the row', () => {
        const params = buildAudiobookWriteParams({
            expanded: expanded({
                id: 'book-1',
                addedAt: 1_700_000_000_000,
                updatedAt: 1_700_000_100_000,
                mtimeMs: 1_699_000_000_000,
                media: {
                    ...expanded({ id: 'book-1' }).media,
                    coverPath: '/covers/x.jpg',
                    duration: 42_000.4,
                    chapters: [{ id: 1, start: 0, end: 10, title: 'Prolog' }],
                    metadata: {
                        ...expanded({ id: 'book-1' }).media.metadata,
                        title: '  Der Schatten über Innsmouth  ',
                        subtitle: 'Ungekürzt',
                        description: 'Beschreibung',
                        publishedYear: '1936',
                        authors: [{ id: 'au-1', name: 'H. P. Lovecraft' }],
                        narrators: ['Ein Sprecher'],
                        series: [{ id: 's-1', name: 'Cthulhu', sequence: '2.5' }],
                        genres: ['Horror'],
                        publisher: 'Verlag',
                        language: 'de',
                        isbn: '123',
                        asin: 'B000',
                        explicit: true,
                        abridged: false,
                    },
                },
            }),
            absLibraryId: 'abs-lib-1',
            libraryPathId: 'lp-1',
            libraryGroupId: 'group-hoerbuecher',
        });

        expect(params.title).toBe('Der Schatten über Innsmouth');
        expect(params.overview).toBe('Beschreibung');
        expect(params.year).toBe(1936);
        expect(params.runtimeSeconds).toBe(42_000);
        expect(params.hasFiles).toBe(true);
        expect(params.libraryAddedAt).toEqual(new Date(1_700_000_000_000));
        expect(params.metadata).toMatchObject({
            libraryId: 'abs-lib-1',
            libraryPathId: 'lp-1',
            updatedAt: 1_700_000_100_000,
            mtimeMs: 1_699_000_000_000,
            authors: ['H. P. Lovecraft'],
            narrators: ['Ein Sprecher'],
            series: [{ id: 's-1', name: 'Cthulhu', sequence: '2.5' }],
            genres: ['Horror'],
            explicit: true,
            coverPath: '/covers/x.jpg',
        });
        expect(params.metadata.chapters).toEqual([{ id: 1, start: 0, end: 10, title: 'Prolog' }]);
    });

    it.each([
        // `sort_title` has no DB trigger, so a missing value would break A-Z on
        // /audiobooks. Without a declared language, keep articles and fold accents.
        ['The Hobbit', 'the hobbit'],
        ['Der Schatten über Innsmouth', 'der schatten uber innsmouth'],
    ])('derives the sort title for %s', (title, expectedSortTitle) => {
        const base = expanded({ id: 'b' });
        const params = buildAudiobookWriteParams({
            expanded: {
                ...base,
                media: { ...base.media, metadata: { ...base.media.metadata, title } },
            },
            absLibraryId: 'abs-lib-1',
            libraryPathId: 'lp-1',
            libraryGroupId: 'g',
        });

        expect(params.title).toBe(title);
        expect(params.sortTitle).toBe(expectedSortTitle);
    });

    it('strips English articles when English is explicitly declared', () => {
        const base = expanded({ id: 'english' });
        const params = buildAudiobookWriteParams({
            expanded: {
                ...base,
                media: {
                    ...base.media,
                    metadata: { ...base.media.metadata, title: 'The Glass Orchard' },
                },
            },
            absLibraryId: 'l',
            libraryPathId: 'lp',
            libraryGroupId: 'g',
            language: 'en',
        });
        expect(params.sortTitle).toBe('glass orchard');
    });

    it.each([
        ['1997', 1997],
        ['1997-04-01', 1997],
        ['', null],
        ['unbekannt', null],
        [null, null],
    ])('parses publishedYear %s as %s', (publishedYear, expectedYear) => {
        const base = expanded({ id: 'b' });
        const params = buildAudiobookWriteParams({
            expanded: {
                ...base,
                media: { ...base.media, metadata: { ...base.media.metadata, publishedYear } },
            },
            absLibraryId: 'abs-lib-1',
            libraryPathId: 'lp-1',
            libraryGroupId: 'g',
        });

        expect(params.year).toBe(expectedYear);
    });

    it('falls back through the listing title and the path before inventing one', () => {
        const base = expanded({ id: 'book-9', relPath: 'Autor/Ein Ordner' });
        const blank = {
            ...base,
            media: { ...base.media, metadata: { ...base.media.metadata, title: '   ' } },
        };

        expect(
            buildAudiobookWriteParams({
                expanded: blank,
                absLibraryId: 'l',
                libraryPathId: 'lp',
                libraryGroupId: 'g',
                fallbackTitle: 'Aus der Liste',
            }).title,
        ).toBe('Aus der Liste');

        expect(
            buildAudiobookWriteParams({
                expanded: blank,
                absLibraryId: 'l',
                libraryPathId: 'lp',
                libraryGroupId: 'g',
            }).title,
        ).toBe('Ein Ordner');

        expect(
            buildAudiobookWriteParams({
                expanded: { ...blank, relPath: null },
                absLibraryId: 'l',
                libraryPathId: 'lp',
                libraryGroupId: 'g',
            }).title,
        ).toBe('Untitled (book-9)');
    });

    it('stores no runtime or added-at when ABS reports neither', () => {
        const base = expanded({ id: 'b', addedAt: 0 });
        const params = buildAudiobookWriteParams({
            expanded: { ...base, media: { ...base.media, duration: null } },
            absLibraryId: 'l',
            libraryPathId: 'lp',
            libraryGroupId: 'g',
        });

        expect(params.runtimeSeconds).toBeNull();
        expect(params.libraryAddedAt).toBeNull();
        expect(params.metadata.addedAt).toBeNull();
    });
});

describe('resolveDismissalRatio', () => {
    it('converts a percentage setting to a ratio', () => {
        expect(resolveDismissalRatio({ [DISMISS_MAX_PERCENT_KEY]: 25 })).toBe(0.25);
    });

    it('accepts a numeric string, because jsonb settings have shipped as strings', () => {
        expect(resolveDismissalRatio({ [DISMISS_MAX_PERCENT_KEY]: '25' })).toBe(0.25);
    });

    it('honours an explicit 0', () => {
        expect(resolveDismissalRatio({ [DISMISS_MAX_PERCENT_KEY]: 0 })).toBe(0);
    });

    it.each([
        ['absent', {}],
        ['empty string', { [DISMISS_MAX_PERCENT_KEY]: '' }],
        ['non-numeric', { [DISMISS_MAX_PERCENT_KEY]: 'ten' }],
        ['negative', { [DISMISS_MAX_PERCENT_KEY]: -5 }],
        ['null', { [DISMISS_MAX_PERCENT_KEY]: null }],
    ])('falls back to the default when the setting is %s', (_label, settings) => {
        expect(resolveDismissalRatio(settings)).toBe(DEFAULT_MAX_DISMISSAL_RATIO);
    });

    it('clamps a nonsense percentage above 100 to "everything"', () => {
        expect(resolveDismissalRatio({ [DISMISS_MAX_PERCENT_KEY]: 500 })).toBe(1);
    });
});
