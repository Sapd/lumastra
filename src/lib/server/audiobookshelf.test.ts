// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudiobookshelfClient } from './audiobookshelf.js';

// `vi.hoisted` — the vi.mock factory below is hoisted above module-level consts.
const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('./utils/logger', () => ({
    Logger: {
        for: () => mockLogger,
    },
}));

// The module builds a singleton from `config` at import time; the tests drive
// their own instances, so config only has to exist.
vi.mock('./config.js', () => ({
    config: {
        AUDIOURL: '',
        AUDIOAPIKEY: '',
    },
}));

const BASE_URL = 'http://abs.test';
const API_KEY = 'test-key';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** A minimal ABS minified library item, as it appears in `results`. */
function minifiedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'li_default',
        libraryId: 'lib_1',
        mtimeMs: 1650621074299,
        addedAt: 1650621073750,
        updatedAt: 1650621110769,
        isMissing: false,
        isInvalid: false,
        mediaType: 'book',
        relPath: 'Terry Vale/Keepers First Rule',
        numFiles: 3,
        size: 48037888,
        media: {
            coverPath: '/audiobooks/cover.jpg',
            duration: 6004.6675,
            numChapters: 20,
            numAudioFiles: 3,
            metadata: {
                title: 'Keepers First Rule',
                subtitle: null,
                authorName: 'Terry Vale',
                narratorName: 'Sam Tsoutsouvas',
                seriesName: 'Lantern of Truth',
                publishedYear: '2008',
            },
        },
        ...overrides,
    };
}

let fetchMock: ReturnType<typeof vi.fn>;
let client: AudiobookshelfClient;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new AudiobookshelfClient(BASE_URL, API_KEY);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

function requestedUrls(): string[] {
    return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('listLibraryItemsMinified', () => {
    it('requests minified items without collapseseries and with the bearer header', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [minifiedItem()], total: 1, limit: 500, page: 0 }),
        );

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(true);
        const url = requestedUrls()[0];
        expect(url).toContain('/api/libraries/lib_1/items');
        expect(url).toContain('minified=1');
        expect(url).toContain('limit=500');
        expect(url).toContain('page=0');
        // collapseseries folds numbered serials into one entry — the id-level
        // diff would then see every other volume as absent upstream.
        expect(url).not.toContain('collapseseries');

        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('clamps limit and page into the supported range', async () => {
        fetchMock.mockImplementation(() =>
            Promise.resolve(jsonResponse({ results: [], total: 0, limit: 1, page: 0 })),
        );

        await client.listLibraryItemsMinified('lib_1', { limit: 0, page: -5 });
        expect(requestedUrls()[0]).toContain('limit=1');
        expect(requestedUrls()[0]).toContain('page=0');

        await client.listLibraryItemsMinified('lib_1', { limit: 99999, page: 2.7 });
        expect(requestedUrls()[1]).toContain('limit=1000');
        expect(requestedUrls()[1]).toContain('page=2');
    });

    it('percent-encodes the library id', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ results: [], total: 0 }));

        await client.listLibraryItemsMinified('lib/../secret');

        expect(requestedUrls()[0]).toContain('/api/libraries/lib%2F..%2Fsecret/items');
    });

    it('normalizes a minified row into a fully populated typed row', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [minifiedItem({ id: 'li_abc' })], total: 1 }),
        );

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items[0]).toEqual({
            id: 'li_abc',
            libraryId: 'lib_1',
            title: 'Keepers First Rule',
            subtitle: null,
            authorName: 'Terry Vale',
            narratorName: 'Sam Tsoutsouvas',
            seriesName: 'Lantern of Truth',
            publishedYear: '2008',
            coverPath: '/audiobooks/cover.jpg',
            relPath: 'Terry Vale/Keepers First Rule',
            mediaType: 'book',
            duration: 6004.6675,
            numChapters: 20,
            numAudioFiles: 3,
            numFiles: 3,
            size: 48037888,
            mtimeMs: 1650621074299,
            addedAt: 1650621073750,
            updatedAt: 1650621110769,
            isMissing: false,
            isInvalid: false,
        });
        expect(result.value.total).toBe(1);
        expect(result.value.page).toBe(0);
        expect(result.value.limit).toBe(500);
    });

    it('falls back to the requested library id and an empty title when ABS omits them', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                results: [{ id: 'li_bare' }],
                total: 1,
            }),
        );

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items[0].libraryId).toBe('lib_1');
        expect(result.value.items[0].title).toBe('');
        expect(result.value.items[0].mtimeMs).toBe(0);
        expect(result.value.items[0].isMissing).toBe(false);
    });

    it('surfaces a non-2xx status instead of returning an empty page', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401));

        const result = await client.listLibraryItemsMinified('lib_1', { page: 3 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('http');
        expect(result.error.status).toBe(401);
        expect(result.error.libraryId).toBe('lib_1');
        expect(result.error.page).toBe(3);
    });

    it('surfaces a rejected fetch as a network error and carries the cause code', async () => {
        const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        fetchMock.mockRejectedValueOnce(err);

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('network');
        expect(result.error.code).toBe('ECONNREFUSED');
        expect(result.error.message).toBe('fetch failed');
    });

    it('latches connectionFailed on ENOTFOUND and reports not-configured afterwards', async () => {
        const err = Object.assign(new Error('getaddrinfo ENOTFOUND abs.test'), {
            cause: { code: 'ENOTFOUND' },
        });
        fetchMock.mockRejectedValueOnce(err);

        const first = await client.listLibraryItemsMinified('lib_1');
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error.kind).toBe('network');

        const second = await client.listLibraryItemsMinified('lib_1');
        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.error.kind).toBe('not-configured');
        // The second call must not hit the network at all.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports not-configured when no base URL or API key is set', async () => {
        const unconfigured = new AudiobookshelfClient('', '');

        const result = await unconfigured.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('not-configured');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports malformed when the body is not JSON', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 200 }));

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed');
    });

    it('reports malformed when `total` is missing, because completeness cannot be verified', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ results: [minifiedItem()] }));

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed');
        expect(result.error.message).toContain('total');
    });

    it('reports malformed when `results` is not an array', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ results: null, total: 0 }));

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed');
    });

    it('fails rather than dropping an entry that has no id', async () => {
        // A dropped entry reads as "absent upstream" to the differ and would
        // dismiss the local row.
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [minifiedItem(), { libraryId: 'lib_1' }], total: 2 }),
        );

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed');
        expect(result.error.message).toContain('usable id');
    });
});

describe('getUserAsAdmin', () => {
    it('reads a full user record with the operator credential', async () => {
        const user = {
            id: 'abs-marc',
            username: 'Marc',
            mediaProgress: [],
        };
        fetchMock.mockResolvedValueOnce(jsonResponse(user));

        await expect(client.getUserAsAdmin('abs/marc')).resolves.toEqual(user);

        expect(requestedUrls()[0]).toBe(`${BASE_URL}/api/users/abs%2Fmarc`);
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('propagates caller cancellation into the underlying fetch', async () => {
        const controller = new AbortController();
        // Held in an object rather than a `let`: TypeScript's control-flow
        // analysis cannot see the assignment inside the fetch callback, so a
        // bare `let` narrows to `never` by the time the assertions read it.
        const captured: { signal: AbortSignal | null } = { signal: null };
        fetchMock.mockImplementation((_url, init: RequestInit) => {
            captured.signal = init.signal as AbortSignal;
            return new Promise((_resolve, reject) => {
                captured.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true,
                });
            });
        });

        const request = client.getUserAsAdmin('abs-marc', controller.signal);
        controller.abort();

        await expect(request).rejects.toThrow(/aborted/);
        expect(captured.signal?.aborted).toBe(true);
    });
});

describe('listLibraryItemsMinified — isMissing / isInvalid parsing', () => {
    async function flagsFor(
        overrides: Record<string, unknown>,
    ): Promise<{ isMissing: boolean; isInvalid: boolean }> {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [minifiedItem(overrides)], total: 1 }),
        );
        const result = await client.listLibraryItemsMinified('lib_1');
        if (!result.ok) throw new Error(`expected ok, got ${result.error.kind}`);
        const { isMissing, isInvalid } = result.value.items[0];
        return { isMissing, isInvalid };
    }

    it('parses boolean true/false', async () => {
        await expect(flagsFor({ isMissing: true, isInvalid: true })).resolves.toEqual({
            isMissing: true,
            isInvalid: true,
        });
        await expect(flagsFor({ isMissing: false, isInvalid: false })).resolves.toEqual({
            isMissing: false,
            isInvalid: false,
        });
    });

    it('parses the numeric 1/0 form ABS has shipped', async () => {
        await expect(flagsFor({ isMissing: 1, isInvalid: 0 })).resolves.toEqual({
            isMissing: true,
            isInvalid: false,
        });
    });

    it('parses the string "true"/"false" form', async () => {
        await expect(flagsFor({ isMissing: 'true', isInvalid: 'false' })).resolves.toEqual({
            isMissing: true,
            isInvalid: false,
        });
    });

    it('defaults to false — the direction that keeps a book playable', async () => {
        // Absent, null and unparseable all mean "present". Guessing `true`
        // would set has_files = false and hide a perfectly good book.
        await expect(flagsFor({ isMissing: undefined, isInvalid: undefined })).resolves.toEqual({
            isMissing: false,
            isInvalid: false,
        });
        await expect(flagsFor({ isMissing: null, isInvalid: null })).resolves.toEqual({
            isMissing: false,
            isInvalid: false,
        });
        await expect(flagsFor({ isMissing: 'yes', isInvalid: 2 })).resolves.toEqual({
            isMissing: false,
            isInvalid: false,
        });
    });

    it('keeps isMissing per-row rather than per-page', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                results: [
                    minifiedItem({ id: 'li_here', isMissing: false }),
                    minifiedItem({ id: 'li_gone', isMissing: true }),
                ],
                total: 2,
            }),
        );

        const result = await client.listLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items.map((i) => [i.id, i.isMissing])).toEqual([
            ['li_here', false],
            ['li_gone', true],
        ]);
    });
});

describe('listAllLibraryItemsMinified', () => {
    /** Queue N pages of `limit`-sized results totalling `total` items. */
    function queuePages(limit: number, total: number): void {
        for (let page = 0; page * limit < total || page === 0; page++) {
            const start = page * limit;
            const results = Array.from(
                { length: Math.max(0, Math.min(limit, total - start)) },
                (_, i) => minifiedItem({ id: `li_${start + i}` }),
            );
            fetchMock.mockResolvedValueOnce(jsonResponse({ results, total, limit, page }));
        }
    }

    it('walks every page until exhausted and concatenates in upstream order', async () => {
        queuePages(2, 5);

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 2 });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items.map((i) => i.id)).toEqual([
            'li_0',
            'li_1',
            'li_2',
            'li_3',
            'li_4',
        ]);
        expect(result.value.total).toBe(5);
        expect(result.value.pagesFetched).toBe(3);
        expect(requestedUrls().map((u) => new URL(u).searchParams.get('page'))).toEqual([
            '0',
            '1',
            '2',
        ]);
    });

    it('stops after a full final page when the collected count reaches total', async () => {
        queuePages(2, 4);

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 2 });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items).toHaveLength(4);
        // 2 pages of 2 == total; no speculative third request.
        expect(result.value.pagesFetched).toBe(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('handles an empty library without erroring', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [], total: 0, limit: 500, page: 0 }),
        );

        const result = await client.listAllLibraryItemsMinified('lib_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items).toEqual([]);
        expect(result.value.total).toBe(0);
    });

    it('surfaces a mid-pagination failure and returns no items at all', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({
                    results: [minifiedItem({ id: 'li_0' }), minifiedItem({ id: 'li_1' })],
                    total: 6,
                    limit: 2,
                    page: 0,
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 2 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('http');
        expect(result.error.status).toBe(500);
        expect(result.error.page).toBe(1);
        expect(result.error.libraryId).toBe('lib_1');
        // Critically: no partial snapshot is handed back. The sweep must not be
        // able to read page 0 as "the whole library" and dismiss li_2..li_5.
        expect(result).not.toHaveProperty('value');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('surfaces a mid-pagination network rejection', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({
                    results: [minifiedItem({ id: 'li_0' })],
                    total: 3,
                    limit: 1,
                    page: 0,
                }),
            )
            .mockRejectedValueOnce(
                Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } }),
            );

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 1 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('network');
        expect(result.error.code).toBe('ECONNRESET');
        expect(result.error.page).toBe(1);
    });

    it('reports incomplete when the server ignores `page` and replays a page', async () => {
        const stuckPage = {
            results: [minifiedItem({ id: 'li_0' }), minifiedItem({ id: 'li_1' })],
            total: 10,
            limit: 2,
        };
        // A fresh Response per call — a body can only be consumed once.
        fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(stuckPage)));

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 2 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('incomplete');
        expect(result.error.message).toContain('did not advance');
        // Bailed on the second page rather than spinning to the page cap.
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('reports incomplete when fewer items arrive than `total` promised', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ results: [minifiedItem({ id: 'li_0' })], total: 9, limit: 4, page: 0 }),
        );

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 4 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('incomplete');
        expect(result.error.message).toContain('Collected 1 of 9');
    });

    it('reports incomplete when the page cap is reached', async () => {
        fetchMock.mockImplementation((url: string) => {
            const page = Number(new URL(url).searchParams.get('page'));
            return Promise.resolve(
                jsonResponse({
                    results: [minifiedItem({ id: `li_${page}` })],
                    total: 100,
                    limit: 1,
                    page,
                }),
            );
        });

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 1, maxPages: 3 });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('incomplete');
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('de-duplicates ids that a shifting sort repeats across pages', async () => {
        fetchMock
            .mockResolvedValueOnce(
                jsonResponse({
                    results: [minifiedItem({ id: 'li_0' }), minifiedItem({ id: 'li_1' })],
                    total: 3,
                    limit: 2,
                    page: 0,
                }),
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    results: [minifiedItem({ id: 'li_1' }), minifiedItem({ id: 'li_2' })],
                    total: 3,
                    limit: 2,
                    page: 1,
                }),
            );

        const result = await client.listAllLibraryItemsMinified('lib_1', { limit: 2 });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.items.map((i) => i.id)).toEqual(['li_0', 'li_1', 'li_2']);
    });
});

describe('getLibraryItemExpanded — duration from audioFiles (real payload shape)', () => {
    /**
     * Verified against a live AudiobookShelf 2.32.1 server: the EXPANDED item
     * payload carries no `media.duration` at all — it exists only on the
     * minified listing. Summing `audioFiles[].duration` is therefore the only
     * source of a book's runtime, and getting this wrong lands every ingested
     * row with a NULL runtime (breaking progress %, the scrubber and the
     * resume rails). The other fixture in this file supplies `media.duration`,
     * which masked the bug.
     */
    function realShape(audioFiles: unknown[]): Record<string, unknown> {
        return {
            id: 'li_real',
            libraryId: 'lib_1',
            folderId: 'fol_1',
            relPath: 'Serie/Folge',
            mediaType: 'book',
            mtimeMs: 1,
            addedAt: 1,
            updatedAt: 1,
            isMissing: false,
            isInvalid: false,
            media: {
                id: 'bk_1',
                libraryItemId: 'li_real',
                coverPath: null,
                tags: [],
                chapters: [],
                audioFiles,
                // NOTE: no `duration`, no `numTracks`, no `numAudioFiles` —
                // exactly what the server actually returns here.
                metadata: { title: 'Folge', authors: [], narrators: [], series: [], genres: [] },
            },
        };
    }

    it('sums audioFiles when media.duration is absent', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                realShape([
                    { index: 1, ino: '101', duration: 1800.5, mimeType: 'audio/mpeg' },
                    { index: 2, ino: '102', duration: 1931.7, mimeType: 'audio/mpeg' },
                ]),
            ),
        );
        const result = await client.getLibraryItemExpanded('li_real');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.media.duration).toBeCloseTo(3732.2, 1);
        expect(result.value.media.audioFiles).toHaveLength(2);
        expect(result.value.media.audioFiles[0].ino).toBe('101');
        // Counts fall back to the array length when the server omits them.
        expect(result.value.media.numAudioFiles).toBe(2);
    });

    it('a file with an unreadable duration contributes 0, not NaN', async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                realShape([
                    { index: 1, ino: '1', duration: 600 },
                    { index: 2, ino: '2', duration: null },
                ]),
            ),
        );
        const result = await client.getLibraryItemExpanded('li_real');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.media.duration).toBe(600);
    });

    it('yields a null duration rather than 0 when nothing is knowable', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(realShape([])));
        const result = await client.getLibraryItemExpanded('li_real');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.media.duration).toBeNull();
    });
});

describe('getLibraryItemExpanded', () => {
    function expandedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            id: 'li_8gch9ve09orgn4fdz8',
            libraryId: 'lib_c1u6t4p45c35rf0nzd',
            folderId: 'fol_bev1zuxhb0j0s1wehr',
            path: '/audiobooks/Terry Vale/Keepers First Rule',
            relPath: 'Terry Vale/Keepers First Rule',
            mediaType: 'book',
            mtimeMs: 1650621074299,
            addedAt: 1650621073750,
            updatedAt: 1650621110769,
            isMissing: false,
            isInvalid: false,
            numFiles: 3,
            size: 48037888,
            media: {
                id: 'bk_1',
                libraryItemId: 'li_8gch9ve09orgn4fdz8',
                coverPath: '/audiobooks/cover.jpg',
                tags: ['Favorite', 7],
                duration: 6004.6675,
                size: 48037888,
                numTracks: 3,
                numAudioFiles: 3,
                chapters: [
                    { id: 0, start: 0, end: 1200.5, title: 'Chapter 1' },
                    { id: 1, start: 1200.5, end: 2400, title: 'Chapter 2' },
                ],
                metadata: {
                    title: 'Keepers First Rule',
                    titleIgnorePrefix: 'Keepers First Rule',
                    subtitle: null,
                    authors: [{ id: 'aut_z3', name: 'Terry Vale' }, { name: 'Anon' }, null],
                    narrators: ['Sam Tsoutsouvas', 42],
                    series: [{ id: 'ser_ca', name: 'Lantern of Truth', sequence: '1' }],
                    genres: ['Fantasy'],
                    publishedYear: '2008',
                    publisher: 'Brilliance Audio',
                    description: 'The masterpiece…',
                    asin: 'B002V0QK4C',
                    explicit: false,
                    abridged: false,
                    authorName: 'Terry Vale',
                    narratorName: 'Sam Tsoutsouvas',
                    seriesName: 'Lantern of Truth',
                },
            },
            ...overrides,
        };
    }

    it('requests the expanded item and percent-encodes the id', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(expandedItem()));

        await client.getLibraryItemExpanded('li_a/b');

        const url = requestedUrls()[0];
        expect(url).toBe(`${BASE_URL}/api/items/li_a%2Fb?expanded=1`);
        const init = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
        expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    });

    it('returns chapters and metadata, normalizing missing and mistyped fields', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(expandedItem()));

        const result = await client.getLibraryItemExpanded('li_8gch9ve09orgn4fdz8');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const item = result.value;

        expect(item.id).toBe('li_8gch9ve09orgn4fdz8');
        expect(item.mtimeMs).toBe(1650621074299);
        expect(item.updatedAt).toBe(1650621110769);
        expect(item.isMissing).toBe(false);

        expect(item.media.chapters).toEqual([
            { id: 0, start: 0, end: 1200.5, title: 'Chapter 1' },
            { id: 1, start: 1200.5, end: 2400, title: 'Chapter 2' },
        ]);

        expect(item.media.metadata.title).toBe('Keepers First Rule');
        expect(item.media.metadata.description).toBe('The masterpiece…');
        expect(item.media.metadata.series).toEqual([
            { id: 'ser_ca', name: 'Lantern of Truth', sequence: '1' },
        ]);
        // Entries without a usable `name`, and non-string array members, are
        // dropped rather than becoming empty strings.
        expect(item.media.metadata.authors).toEqual([
            { id: 'aut_z3', name: 'Terry Vale' },
            { id: null, name: 'Anon' },
        ]);
        expect(item.media.metadata.narrators).toEqual(['Sam Tsoutsouvas']);
        expect(item.media.tags).toEqual(['Favorite']);
        // Fields ABS omitted are null, never undefined.
        expect(item.media.metadata.isbn).toBeNull();
        expect(item.media.metadata.language).toBeNull();
        expect(item.media.metadata.publishedDate).toBeNull();
    });

    it('treats an absent `chapters` array as no chapters', async () => {
        const raw = expandedItem();
        const media = raw.media as Record<string, unknown>;
        delete media.chapters;
        fetchMock.mockResolvedValueOnce(jsonResponse(raw));

        const result = await client.getLibraryItemExpanded('li_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.media.chapters).toEqual([]);
    });

    it('fills a chapter id from its index and end from start when ABS omits them', async () => {
        const raw = expandedItem();
        (raw.media as Record<string, unknown>).chapters = [{ start: 0, title: 'Only chapter' }];
        fetchMock.mockResolvedValueOnce(jsonResponse(raw));

        const result = await client.getLibraryItemExpanded('li_1');

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.media.chapters).toEqual([
            { id: 0, start: 0, end: 0, title: 'Only chapter' },
        ]);
    });

    it('fails rather than silently dropping an unusable chapter', async () => {
        const raw = expandedItem();
        (raw.media as Record<string, unknown>).chapters = [
            { id: 0, start: 0, end: 10, title: 'Good' },
            { id: 1, title: 'No start' },
        ];
        fetchMock.mockResolvedValueOnce(jsonResponse(raw));

        const result = await client.getLibraryItemExpanded('li_1');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed');
        expect(result.error.message).toContain('index 1');
        expect(result.error.itemId).toBe('li_1');
    });

    it('reports malformed when media or metadata is absent', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'li_1' }));
        const noMedia = await client.getLibraryItemExpanded('li_1');
        expect(noMedia.ok).toBe(false);
        if (!noMedia.ok) expect(noMedia.error.message).toContain('`media`');

        fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'li_1', media: {} }));
        const noMetadata = await client.getLibraryItemExpanded('li_1');
        expect(noMetadata.ok).toBe(false);
        if (!noMetadata.ok) expect(noMetadata.error.message).toContain('`media.metadata`');
    });

    it('surfaces a 404 for an item that vanished between sweep and fetch', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));

        const result = await client.getLibraryItemExpanded('li_gone');

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('http');
        expect(result.error.status).toBe(404);
        expect(result.error.itemId).toBe('li_gone');
    });
});

// ── Redirect policy (C29 fix-plan finding) ──────────────────────────────────
//
// AudiobookshelfClient sends a bearer token/API key on every request and
// previously used bare `fetch()` (default redirect:'follow') for most of its
// methods. `getSessions()` is a representative bare-fetch call site: these
// tests prove it now routes through the same-origin-only redirect policy
// enforced by `$lib/server/utils/fetch-timeout.js` `fetchWithTimeout`.
describe('getSessions — redirect policy (C29)', () => {
    it('follows a same-origin redirect', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: `${BASE_URL}/api/sessions/open/moved` },
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'sess_1' }] }));

        const sessions = await client.getSessions();

        expect(sessions).toEqual([{ id: 'sess_1' }]);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refuses a cross-origin redirect and degrades to an empty list', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { location: 'http://attacker.test/api/sessions/open' },
            }),
        );

        const sessions = await client.getSessions();

        expect(sessions).toEqual([]);
        // Only the original request was made — the redirect target was never
        // contacted.
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('open sessions during an upstream outage', () => {
    it('retains the last successful snapshot for at most one minute', async () => {
        const clock = vi.spyOn(Date, 'now');
        const now = Date.now();
        clock.mockReturnValue(now);
        fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'live' }] }));
        expect(await client.getSessions({ allowStaleForDisplay: true })).toEqual([{ id: 'live' }]);
        fetchMock.mockRejectedValue(new Error('connection refused'));
        clock.mockReturnValue(now + 30_000);
        expect(await client.getSessions({ allowStaleForDisplay: true })).toEqual([{ id: 'live' }]);
        clock.mockReturnValue(now + 60_001);
        expect(await client.getSessions({ allowStaleForDisplay: true })).toEqual([]);
        clock.mockRestore();
    });
    it('never supplies the display snapshot to fresh-only background callers', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'live' }] }));
        await client.getSessions();
        fetchMock.mockRejectedValueOnce(new Error('connection refused'));
        expect(await client.getSessions()).toEqual([]);
    });
    it('clears the fallback as soon as upstream reports no sessions', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [{ id: 'live' }] }));
        await client.getSessions({ allowStaleForDisplay: true });
        fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [] }));
        expect(await client.getSessions({ allowStaleForDisplay: true })).toEqual([]);
        fetchMock.mockRejectedValueOnce(new Error('connection refused'));
        expect(await client.getSessions({ allowStaleForDisplay: true })).toEqual([]);
    });
});
