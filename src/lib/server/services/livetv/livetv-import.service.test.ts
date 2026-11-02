// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type postgres from 'postgres';

// ── Module mocks (hoisted) ───────────────────────────────────────────────

vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: vi.fn(),
}));

// The connection-pinning transport is covered at its seam in fetch-source.test.ts
// and ssrf-guard.test.ts; here it only needs to reach the global fetch stub. The
// fixtures are plain `{ ok, status, text }` objects, and fetch-source reads a real
// body stream (with a size cap), so each one is wrapped in a Response.
vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    pinnedFetch: async (safe: { url: URL }, init?: RequestInit) => {
        const res = (await globalThis.fetch(safe.url, init)) as Partial<Response>;
        if (res instanceof Response) return res;
        const status = res.status ?? (res.ok === false ? 500 : 200);
        return new Response(res.text ? await res.text() : null, { status });
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: { LIVETV_ALLOW_PRIVATE_URLS: false, LIVETV_UPSTREAM_PROXY_URL: '' },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            child: vi.fn(function (this: unknown) {
                return this;
            }),
        }),
    },
}));

// Forwards to the real fetcher; only lets a test see the options it was called with.
vi.mock('./fetch-source.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./fetch-source.js')>();
    return { ...actual, fetchSsrfValidatedText: vi.fn(actual.fetchSsrfValidatedText) };
});

vi.mock('./m3u-parser.js', () => ({
    parseM3uAsync: vi.fn(),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    acquireLock: vi.fn().mockResolvedValue('lock-token'),
    releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./auto-processor.js', () => ({
    processChannels: vi.fn(),
}));

vi.mock('./epg-matcher.js', () => ({
    matchEpgChannels: vi.fn(),
    // Delegates to the sync mock so tests keep configuring matchEpgChannels.
    matchEpgChannelsAsync: vi.fn(async (...args: unknown[]) => {
        const mod = await import('./epg-matcher.js');
        return (mod.matchEpgChannels as (...a: unknown[]) => unknown)(...args);
    }),
}));

vi.mock('./xmltv-parser.js', () => ({
    parseXmltv: vi.fn(),
}));

vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    getSourceByIdWithCredentials: vi.fn(),
    updateRefreshStatus: vi.fn(),
    updateEpgRefreshStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    bulkCreateChannels: vi.fn(),
    deleteChannelsBySourceId: vi.fn(),
    deleteUnusedBackupGroupsOfSource: vi.fn().mockResolvedValue(0),
    getChannelsBySourceId: vi.fn(),
    shareBackupGroupLogos: vi.fn().mockResolvedValue(0),
    purgeEmptyCategories: vi.fn().mockResolvedValue(0),
    getSourceFavoritesForImport: vi.fn().mockResolvedValue([]),
    restoreSourceFavorites: vi.fn(),
}));

vi.mock('$lib/server/database/queries/livetv-setup.queries.js', () => ({
    getSourceLineupFilter: vi.fn().mockResolvedValue(null),
}));

vi.mock('./livetv-setup.service.js', () => ({
    applySetupPreferences: vi.fn(),
}));

// Only randomUUID is stubbed — programme ids are derived with a real createHash
// (see program-id.ts), so the rest of the module has to stay intact.
vi.mock('node:crypto', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:crypto')>()),
    randomUUID: vi.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────────

import { importM3uSource, importEpgSource } from './livetv-import.service.js';
import {
    fetchSsrfValidatedText,
    M3U_MAX_FETCH_BYTES,
    XMLTV_MAX_FETCH_BYTES,
} from './fetch-source.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import { parseM3uAsync } from './m3u-parser.js';
import { processChannels } from './auto-processor.js';
import { matchEpgChannels } from './epg-matcher.js';
import { parseXmltv } from './xmltv-parser.js';
import {
    getSourceByIdWithCredentials,
    updateRefreshStatus,
    updateEpgRefreshStatus,
} from '$lib/server/database/queries/livetv-sources.queries.js';
import {
    bulkCreateChannels,
    deleteChannelsBySourceId,
    getChannelsBySourceId,
    shareBackupGroupLogos,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { randomUUID } from 'node:crypto';
import { acquireLock } from '$lib/server/cache/valkey.js';
import { getSourceLineupFilter } from '$lib/server/database/queries/livetv-setup.queries.js';
import { applySetupPreferences } from './livetv-setup.service.js';

// ── Typed mocks ─────────────────────────────────────────────────────────

const mockValidateUrl = validateUrl as MockedFunction<typeof validateUrl>;
const mockParseM3u = parseM3uAsync as MockedFunction<typeof parseM3uAsync>;
const mockProcessChannels = processChannels as MockedFunction<typeof processChannels>;
const mockMatchEpgChannels = matchEpgChannels as MockedFunction<typeof matchEpgChannels>;
const mockParseXmltv = parseXmltv as MockedFunction<typeof parseXmltv>;
const mockGetSource = getSourceByIdWithCredentials as MockedFunction<
    typeof getSourceByIdWithCredentials
>;
const mockUpdateRefreshStatus = updateRefreshStatus as MockedFunction<typeof updateRefreshStatus>;
const mockBulkCreateChannels = bulkCreateChannels as MockedFunction<typeof bulkCreateChannels>;
const mockDeleteChannels = deleteChannelsBySourceId as MockedFunction<
    typeof deleteChannelsBySourceId
>;
const mockGetChannelsBySourceId = getChannelsBySourceId as MockedFunction<
    typeof getChannelsBySourceId
>;
const mockRandomUUID = randomUUID as MockedFunction<
    () => `${string}-${string}-${string}-${string}-${string}`
>;

// ── Fixtures ────────────────────────────────────────────────────────────

const SOURCE_ID = 'src-uuid-1234';

function makeSource(overrides: Record<string, unknown> = {}) {
    return {
        id: SOURCE_ID,
        name: 'Test Source',
        source_type: 'm3u' as const,
        m3u_url: 'http://provider.example/playlist.m3u',
        xmltv_url: 'http://provider.example/epg.xml',
        xtream_server: null,
        xtream_username: null,
        xtream_password: null,
        hdhomerun_device_ip: null,
        hdhomerun_device_id: null,
        max_streams: 1,
        refresh_cron: null,
        last_refresh_at: null,
        last_refresh_status: null,
        last_refresh_summary: null,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

function makeM3uChannel(name: string) {
    return {
        name,
        tvgId: `${name}.de`,
        tvgName: name,
        logoUrl: `http://logos.example/${name}.png`,
        groupTitle: 'News',
        streamUrl: `http://provider.example/live/user/pass/${name}.ts`,
        countryCode: 'de',
        extras: {},
    };
}

function makeProcessedChannel(name: string) {
    return {
        original: makeM3uChannel(name),
        qualityTier: 'hd' as const,
        baseName: name,
        category: 'News',
        backupGroupKey: undefined as string | undefined,
        isPrimary: false,
        isVod: false,
        regionalVariant: undefined,
        region: undefined as string | undefined,
    };
}

function makeProcessingResult(channelNames: string[]) {
    return {
        channels: channelNames.map(makeProcessedChannel),
        backupGroups: [],
        categories: [{ rawGroupTitle: 'News', normalizedName: 'News' }],
        vodCount: 0,
        separatorCount: 0,
        stats: {
            totalInput: channelNames.length,
            totalAfterVodFilter: channelNames.length,
            backupGroupCount: 0,
            uniqueChannelCount: channelNames.length,
            categoryCount: 1,
            regionalVariantCount: 0,
        },
        warnings: [],
    };
}

function makeParseResult(channelNames: string[]) {
    return {
        imported: channelNames.length,
        skipped: 0,
        channels: channelNames.map(makeM3uChannel),
        errors: [],
        warnings: [],
    };
}

function makeXmltvResult() {
    return {
        channels: [{ id: 'News.de', displayName: 'News', iconUrl: undefined }],
        programs: [
            {
                channelId: 'News.de',
                title: 'Morning News',
                description: 'Daily news',
                startTime: '2026-03-09T06:00:00+01:00',
                endTime: '2026-03-09T07:00:00+01:00',
                genres: ['News'],
                officialRating: undefined as string | undefined,
            },
        ],
        channelCount: 1,
        programCount: 1,
        skipped: 0,
        errors: [],
        warnings: [],
    };
}

function makeDbChannel(id: string, name: string) {
    return {
        id,
        name,
        stream_url: `http://provider.example/${name}.ts`,
        logo_url: null as string | null,
        quality_tier: 'hd' as string | null,
        epg_channel_id: `${name}.de` as string | null,
        sort_order: 0,
        is_visible: true,
        category_id: null as string | null,
        category_name: null as string | null,
        backup_group_id: null as string | null,
        source_id: SOURCE_ID as string | null,
        country_code: null as string | null,
        consecutive_absences: 0,
        created_at: new Date(),
    };
}

function makeEpgMatchResult(channelIndex: number, epgChannelId: string) {
    return {
        matches: [
            {
                channelIndex,
                channelName: 'News',
                tvgId: `${epgChannelId}`,
                epgChannelId,
                epgDisplayName: 'News',
                confidence: 0.95,
                signals: ['tvg_id_exact' as const],
            },
        ],
        unmatched: [],
        stats: {
            totalChannels: 1,
            matched: 1,
            unmatched: 0,
            bySignal: {
                tvg_id_exact: 1,
                tvg_id_partial: 0,
                tvg_name_match: 0,
                name_exact: 0,
                name_fuzzy: 0,
                group_title: 0,
                backup_propagation: 0,
            },
            averageConfidence: 0.95,
        },
        warnings: [],
    };
}

// A mock sql tag that behaves as a no-op for direct SQL inserts
function makeSql() {
    const sqlFn = vi.fn().mockResolvedValue([]);
    (sqlFn as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);
    (sqlFn as unknown as Record<string, unknown>).json = vi.fn((v: unknown) => v);
    // Transaction support: sql.begin(cb) calls cb with a mock tx
    // Every argument list the transaction handle was called with, so tests can
    // assert on the rows actually handed to INSERT.
    const txCalls: unknown[][] = [];
    (sqlFn as unknown as Record<string, unknown>).begin = vi.fn(
        async (cb: (tx: unknown) => Promise<unknown>) => {
            const txFn = vi.fn((...args: unknown[]) => {
                txCalls.push(args);
                return Promise.resolve([]);
            });
            (txFn as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);
            (txFn as unknown as Record<string, unknown>).json = vi.fn((v: unknown) => v);
            return cb(txFn);
        },
    );
    (sqlFn as unknown as Record<string, unknown>).__txCalls = txCalls;
    return sqlFn as unknown as postgres.Sql;
}

/** Rows passed to the program INSERT (the tx call carrying `channel_id`). */
function insertedProgramRows(sql: postgres.Sql): Array<Record<string, unknown>> {
    const calls = (sql as unknown as { __txCalls: unknown[][] }).__txCalls;
    // The insert reaches the mock as tx(chunk, 'channel_id', 'title', ...), while
    // the surrounding tagged template reaches it as tx(strings, ...values) — so
    // scan every argument rather than assuming a position.
    for (const args of calls) {
        for (const arg of args) {
            const first = Array.isArray(arg) ? arg[0] : undefined;
            if (
                typeof first === 'object' &&
                first !== null &&
                'channel_id' in first &&
                'start_time' in first
            ) {
                return arg as Array<Record<string, unknown>>;
            }
        }
    }
    return [];
}

// ── importM3uSource tests ────────────────────────────────────────────────

describe('importM3uSource', () => {
    let sql: postgres.Sql;

    beforeEach(() => {
        vi.clearAllMocks();
        sql = makeSql();

        // Default happy-path mocks
        mockGetSource.mockResolvedValue(makeSource());
        mockValidateUrl.mockResolvedValue({
            valid: true,
            resolvedUrl: 'http://1.2.3.4/playlist.m3u',
            resolvedIp: '1.2.3.4',
        });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('#EXTM3U\n#EXTINF:-1,News\nhttp://example.com/news.ts'),
        } as Response);
        mockParseM3u.mockResolvedValue(makeParseResult(['News']));
        mockProcessChannels.mockReturnValue(makeProcessingResult(['News']));
        mockDeleteChannels.mockResolvedValue(0);
        mockBulkCreateChannels.mockResolvedValue({
            channelCount: 1,
            categoryCount: 1,
            backupGroupCount: 0,
        });
        mockUpdateRefreshStatus.mockResolvedValue(true);

        let uuidCount = 0;
        mockRandomUUID.mockImplementation(
            () =>
                `00000000-0000-0000-0000-${String(++uuidCount).padStart(12, '0')}` as ReturnType<
                    typeof randomUUID
                >,
        );
    });

    it('fetches the playlist with the M3U byte ceiling', async () => {
        await importM3uSource(sql, SOURCE_ID);

        expect(vi.mocked(fetchSsrfValidatedText)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSsrfValidatedText).mock.calls[0][1]).toMatchObject({
            maxBytes: M3U_MAX_FETCH_BYTES,
        });
    });

    it('returns ImportResult with correct counts on successful import', async () => {
        const result = await importM3uSource(sql, SOURCE_ID);

        expect(result.sourceId).toBe(SOURCE_ID);
        expect(result.sourceName).toBe('Test Source');
        expect(result.channelCount).toBe(1);
        expect(result.categoryCount).toBe(1);
        expect(result.backupGroupCount).toBe(0);
        expect(result.epgMatchCount).toBe(0);
        expect(result.programCount).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('throws when source is not found', async () => {
        mockGetSource.mockResolvedValue(null);

        await expect(importM3uSource(sql, 'missing-id')).rejects.toThrow(
            'Source not found: missing-id',
        );
    });

    it('throws when source has no M3U URL', async () => {
        mockGetSource.mockResolvedValue(makeSource({ m3u_url: null }));

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow(
            `Source ${SOURCE_ID} has no M3U URL`,
        );
    });

    it('throws when SSRF validation blocks the URL', async () => {
        mockValidateUrl.mockResolvedValue({
            valid: false,
            reason: 'private IP range',
        });

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow(
            'SSRF blocked: private IP range',
        );
    });

    it('throws when fetch returns a non-OK status', async () => {
        global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 } as Response);

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow(
            'Failed to fetch M3U: HTTP 403',
        );
    });

    it('throws when M3U parses to zero channels', async () => {
        mockParseM3u.mockResolvedValue(makeParseResult([]));

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow(
            'M3U parsing produced zero channels',
        );
    });

    it('calls progress callback at each phase', async () => {
        const callback = vi.fn().mockResolvedValue(undefined);

        await importM3uSource(sql, SOURCE_ID, callback);

        const phases = callback.mock.calls.map(
            (call: unknown[]) => (call[0] as { phase: string }).phase,
        );
        expect(phases).toContain('fetching');
        expect(phases).toContain('parsing');
        expect(phases).toContain('processing');
        expect(phases).toContain('clearing');
        expect(phases).toContain('persisting');
        expect(phases).toContain('complete');
    });

    it('collects parse errors into the result', async () => {
        mockParseM3u.mockResolvedValue({
            ...makeParseResult(['News']),
            errors: [{ line: 42, content: 'bad line', reason: 'missing comma' }],
        });

        const result = await importM3uSource(sql, SOURCE_ID);

        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('line 42');
        expect(result.errors[0]).toContain('missing comma');
    });

    it('collects parse warnings into the result', async () => {
        mockParseM3u.mockResolvedValue({
            ...makeParseResult(['News']),
            warnings: [
                {
                    line: 3,
                    field: 'tvg-id',
                    message: 'Channel "News" missing tvg-id (needed for EPG matching)',
                },
                {
                    line: 3,
                    field: 'tvg-logo',
                    message: 'Channel "News" missing tvg-logo',
                },
            ],
        });

        const result = await importM3uSource(sql, SOURCE_ID);

        expect(result.warnings).toHaveLength(2);
        expect(result.warnings[0]).toContain('Line 3');
        expect(result.warnings[0]).toContain('missing tvg-id');
        expect(result.warnings[1]).toContain('missing tvg-logo');
    });

    it('includes warnings in updateRefreshStatus summary', async () => {
        mockParseM3u.mockResolvedValue({
            ...makeParseResult(['News']),
            warnings: [
                {
                    line: 3,
                    field: 'tvg-id',
                    message: 'Channel "News" missing tvg-id',
                },
            ],
        });

        await importM3uSource(sql, SOURCE_ID);

        expect(mockUpdateRefreshStatus).toHaveBeenCalledWith(
            sql,
            SOURCE_ID,
            'success',
            expect.objectContaining({
                warnings: ['Line 3: Channel "News" missing tvg-id'],
            }),
        );
    });

    it('calls deleteChannelsBySourceId before bulk insert', async () => {
        await importM3uSource(sql, SOURCE_ID);

        expect(mockDeleteChannels).toHaveBeenCalledWith(expect.anything(), SOURCE_ID);
        const deleteOrder = mockDeleteChannels.mock.invocationCallOrder[0];
        const insertOrder = mockBulkCreateChannels.mock.invocationCallOrder[0];
        expect(deleteOrder).toBeLessThan(insertOrder);
    });

    it('calls updateRefreshStatus with success after import', async () => {
        await importM3uSource(sql, SOURCE_ID);

        expect(mockUpdateRefreshStatus).toHaveBeenCalledWith(
            sql,
            SOURCE_ID,
            'success',
            expect.objectContaining({
                channelCount: 1,
            }),
        );
    });

    it('records a failed status (URL redacted) when the channel insert throws', async () => {
        mockBulkCreateChannels.mockRejectedValue(
            new Error(
                'MAX_PARAMETERS_EXCEEDED: Max number of parameters (65534) exceeded ' +
                    'http://iptv.example/get.php?username=alice&password=hunter2',
            ),
        );

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow('MAX_PARAMETERS_EXCEEDED');

        expect(mockUpdateRefreshStatus).toHaveBeenCalledTimes(1);
        expect(mockUpdateRefreshStatus).toHaveBeenCalledWith(
            sql,
            SOURCE_ID,
            'failed',
            expect.objectContaining({ error: expect.stringContaining('MAX_PARAMETERS_EXCEEDED') }),
        );
        const summary = mockUpdateRefreshStatus.mock.calls[0][3] as { error: string };
        expect(summary.error).not.toContain('hunter2');
        expect(summary.error).not.toContain('alice');
    });

    it('waits for an older import before reading the latest settings instead of dropping the follow-up', async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(acquireLock)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce('follow-up-lock');
            const result = importM3uSource(sql, SOURCE_ID, undefined, true).then(
                () => true,
                () => false,
            );
            await vi.advanceTimersByTimeAsync(0);
            expect(mockGetSource).not.toHaveBeenCalled();
            mockGetSource.mockResolvedValue(
                makeSource({ m3u_url: 'http://provider.example/new-token.m3u' }),
            );
            await vi.advanceTimersByTimeAsync(1000);
            expect(vi.mocked(fetchSsrfValidatedText)).toHaveBeenCalledWith(
                'http://provider.example/new-token.m3u',
                expect.any(Object),
            );
            expect(await result).toBe(true);
            expect(acquireLock).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });
    it('counts saving progress against live channels, not VOD entries', async () => {
        const processed = makeProcessingResult(['News', 'Sport', 'Film A', 'Film B', 'Film C']);
        processed.channels.slice(2).forEach((ch) => (ch.isVod = true));
        processed.vodCount = 3;
        mockProcessChannels.mockReturnValue(processed);
        const progress = vi.fn().mockResolvedValue(undefined);

        await importM3uSource(sql, SOURCE_ID, progress);

        const saving = progress.mock.calls.map(([p]) => p).find((p) => p.phase === 'persisting');
        expect(saving).toMatchObject({ processed: 0, total: 2 });
        expect(saving.message).toContain('3 VOD entries and 0 section headers skipped');
    });

    it('does not record a failed status when an admin cancelled the import', async () => {
        mockBulkCreateChannels.mockRejectedValue(new Error('Cancelled by admin'));

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow('Cancelled by admin');

        expect(mockUpdateRefreshStatus).not.toHaveBeenCalled();
    });
    it('persists the detected region as the channel country', async () => {
        const processing = makeProcessingResult(['RO: Pro TV']);
        processing.channels[0].region = 'ro';
        mockProcessChannels.mockReturnValue(processing);

        await importM3uSource(sql, SOURCE_ID);

        const data = mockBulkCreateChannels.mock.calls[0][1];
        expect(data.channels[0].countryCode).toBe('ro');
    });

    it('shares a station logo across its backup group after the channels are written', async () => {
        await importM3uSource(sql, SOURCE_ID);

        expect(vi.mocked(shareBackupGroupLogos)).toHaveBeenCalledWith(sql, SOURCE_ID);
        expect(mockBulkCreateChannels.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(shareBackupGroupLogos).mock.invocationCallOrder[0],
        );
    });

    it('leaves a never-configured source fully visible', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValue(null);

        await importM3uSource(sql, SOURCE_ID);

        expect(vi.mocked(applySetupPreferences)).not.toHaveBeenCalled();
    });

    it('reapplies only the noise switches the stored choices have', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValue({
            countries: [],
            includeUntagged: true,
            hideLoopChannels: true,
            hideRadio: true,
            hideEventSlots: false,
            hiddenCategories: ['Rivage+'],
        });
        vi.mocked(applySetupPreferences).mockResolvedValue({
            success: true,
            visibleChannels: 1,
            hiddenChannels: 0,
            categories: 1,
            message: '',
        });

        await importM3uSource(sql, SOURCE_ID);

        const prefs = vi.mocked(applySetupPreferences).mock.calls[0][1];
        expect(prefs).toMatchObject({ hideRadio: true, hideEventSlots: false });
        expect(prefs).not.toHaveProperty('hideInfoChannels');
        expect(prefs).not.toHaveProperty('hideLocalStations');
        // Hidden bouquets stay categories so their channels stay hidden.
        expect(vi.mocked(processChannels).mock.calls[0][1]).toEqual({
            keepCategories: new Set(['Rivage+']),
        });
    });

    it('reapplies the stored Configure Lineup choices after the channels are replaced', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValue({
            countries: ['de', 'uk'],
            includeUntagged: false,
            hideLoopChannels: true,
            hiddenCategories: ['Shopping'],
            channelOrder: 'sports-first',
            preferHighQuality: false,
        });
        vi.mocked(applySetupPreferences).mockResolvedValue({
            success: true,
            visibleChannels: 1,
            hiddenChannels: 0,
            categories: 1,
            message: '',
        });

        const result = await importM3uSource(sql, SOURCE_ID);

        // Runs on the import's transaction handle, not the top-level sql.
        expect(vi.mocked(applySetupPreferences)).toHaveBeenCalledWith(expect.any(Function), {
            sourceId: SOURCE_ID,
            countries: ['de', 'uk'],
            includeUntagged: false,
            hideLoopChannels: true,
            hiddenCategories: ['Shopping'],
            channelOrder: 'sports-first',
            preferHighQuality: false,
        });
        expect(mockBulkCreateChannels.mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(applySetupPreferences).mock.invocationCallOrder[0],
        );
        expect(result.warnings).toEqual([]);
        expect(mockUpdateRefreshStatus.mock.calls.at(-1)?.[3]).toMatchObject({
            lineupVisible: 1,
            lineupHidden: 0,
        });
    });

    it('fails the import when the stored lineup cannot be applied (the transaction rolls back)', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValue({ countries: ['de'] });
        vi.mocked(applySetupPreferences).mockRejectedValue(new Error('boom'));

        await expect(importM3uSource(sql, SOURCE_ID)).rejects.toThrow('boom');

        expect(mockUpdateRefreshStatus.mock.calls.at(-1)?.[2]).toBe('failed');
        expect(vi.mocked(shareBackupGroupLogos)).not.toHaveBeenCalled();
    });
});

// ── importEpgSource tests ────────────────────────────────────────────────

describe('importEpgSource', () => {
    let sql: postgres.Sql;

    beforeEach(() => {
        vi.clearAllMocks();
        sql = makeSql();

        // Default happy-path mocks
        mockGetSource.mockResolvedValue(makeSource());
        mockValidateUrl.mockResolvedValue({
            valid: true,
            resolvedUrl: 'http://1.2.3.4/epg.xml',
            resolvedIp: '1.2.3.4',
        });
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve('<tv></tv>'),
        } as Response);
        mockParseXmltv.mockReturnValue(makeXmltvResult());
        mockGetChannelsBySourceId.mockResolvedValue([makeDbChannel('ch-uuid-1', 'News')]);
        mockMatchEpgChannels.mockReturnValue(makeEpgMatchResult(0, 'News.de'));
        mockUpdateRefreshStatus.mockResolvedValue(true);
        vi.mocked(updateEpgRefreshStatus).mockReset().mockResolvedValue(true);

        let uuidCount = 0;
        mockRandomUUID.mockImplementation(
            () =>
                `00000000-0000-0000-0000-${String(++uuidCount).padStart(12, '0')}` as ReturnType<
                    typeof randomUUID
                >,
        );
    });

    it('records EPG failures with a redacted actionable error', async () => {
        vi.mocked(fetchSsrfValidatedText).mockRejectedValueOnce(
            new Error('Could not fetch http://user:secret@provider.example/epg?password=secret'),
        );
        await expect(importEpgSource(sql, SOURCE_ID)).rejects.toThrow('Could not fetch');
        expect(vi.mocked(updateEpgRefreshStatus)).toHaveBeenCalledWith(sql, SOURCE_ID, 'failed', {
            error: expect.stringContaining('Could not fetch'),
        });
        expect(JSON.stringify(vi.mocked(updateEpgRefreshStatus).mock.calls)).not.toContain(
            'secret',
        );
    });
    it.each([0, 1, 5])(
        'warns only when fewer than 5 percent of channels match (%i/100)',
        async (matched) => {
            mockGetChannelsBySourceId.mockResolvedValue(
                Array.from({ length: 100 }, (_, i) => makeDbChannel(`ch-${i}`, `Channel ${i}`)),
            );
            mockMatchEpgChannels.mockReturnValue({
                ...makeEpgMatchResult(0, 'News.de'),
                matches: Array.from({ length: matched }, (_, i) => ({
                    ...makeEpgMatchResult(i, 'News.de').matches[0],
                })),
                stats: {
                    ...makeEpgMatchResult(0, 'News.de').stats,
                    matched,
                    unmatched: 100 - matched,
                    totalChannels: 100,
                },
            });
            const result = await importEpgSource(sql, SOURCE_ID);
            expect(result.warnings.length > 0).toBe(matched < 5);
            if (matched < 5) expect(result.warnings.join(' ')).toContain('XMLTV');
        },
    );
    it('does not warn about hidden channels when every visible channel matches', async () => {
        mockGetChannelsBySourceId.mockResolvedValue([
            makeDbChannel('visible', 'News'),
            ...Array.from({ length: 99 }, (_, i) => ({
                ...makeDbChannel(`hidden-${i}`, 'Other'),
                is_visible: false,
            })),
        ]);
        mockMatchEpgChannels.mockReturnValue(makeEpgMatchResult(0, 'News.de'));
        expect((await importEpgSource(sql, SOURCE_ID)).warnings).toEqual([]);
    });
    it('warns when only hidden channels match', async () => {
        mockGetChannelsBySourceId.mockResolvedValue([
            makeDbChannel('visible', 'News'),
            { ...makeDbChannel('hidden', 'Other'), is_visible: false },
        ]);
        mockMatchEpgChannels.mockReturnValue(makeEpgMatchResult(1, 'Other.de'));
        expect((await importEpgSource(sql, SOURCE_ID)).warnings.join(' ')).toContain('0 of 1');
    });
    it('fetches the guide with the XMLTV byte ceiling', async () => {
        await importEpgSource(sql, SOURCE_ID);

        expect(vi.mocked(fetchSsrfValidatedText)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSsrfValidatedText).mock.calls[0][1]).toMatchObject({
            maxBytes: XMLTV_MAX_FETCH_BYTES,
        });
    });

    it('returns ImportResult with correct counts on successful EPG import', async () => {
        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.sourceId).toBe(SOURCE_ID);
        expect(result.sourceName).toBe('Test Source');
        expect(result.epgMatchCount).toBe(1);
        expect(result.programCount).toBe(1);
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('stamps each program with the XMLTV channel id it came from', async () => {
        await importEpgSource(sql, SOURCE_ID);

        const rows = insertedProgramRows(sql);
        expect(rows).toHaveLength(1);
        expect(rows[0].epg_id).toBe('News.de');
    });

    // Every refresh replaces a channel's listings wholesale, so a DB-assigned
    // gen_random_uuid() handed each programme a new id every few hours and every
    // client holding the guide started 404ing on /j/Items/{programId}. The id has
    // to be derived from the programme, not from the insert.
    it('gives a programme the same id across repeated imports', async () => {
        await importEpgSource(sql, SOURCE_ID);
        const first = insertedProgramRows(sql);

        const secondSql = makeSql();
        await importEpgSource(secondSql, SOURCE_ID);
        const second = insertedProgramRows(secondSql);

        expect(first).toHaveLength(1);
        expect(first[0].id).toEqual(expect.any(String));
        expect(second[0].id).toBe(first[0].id);
        // Not a randomUUID() draw — that mock counts up from ...000000000001.
        expect(first[0].id).not.toMatch(/^00000000-0000-0000-0000-/);
    });

    it('gives programmes on the same channel distinct ids per start time', async () => {
        const xmltv = makeXmltvResult();
        const base = xmltv.programs[0];
        xmltv.programs = [
            base,
            {
                ...base,
                title: 'Nachrichtenblick',
                startTime: new Date(Date.parse(base.endTime)).toISOString(),
                endTime: new Date(Date.parse(base.endTime) + 30 * 60_000).toISOString(),
            },
        ];
        mockParseXmltv.mockReturnValue(xmltv);

        await importEpgSource(sql, SOURCE_ID);

        const rows = insertedProgramRows(sql);
        expect(rows).toHaveLength(2);
        expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('collapses parallel schedules the feed ships under one tvg-id', async () => {
        // Aggregators reuse one channel id for several variants and concatenate
        // each variant's schedule under it. Both chains below are internally
        // contiguous and shifted by ~3 minutes — no shared start time, so no
        // exact-duplicate test would catch them.
        const chain = (offsetSec: number) =>
            ['Riffhai', 'Nationalparks', 'Into the Blue'].map((title, i) => {
                const start = Date.UTC(2026, 6, 28, 12, 0, 0) + offsetSec * 1000 + i * 55 * 60_000;
                return {
                    channelId: 'News.de',
                    title,
                    description: undefined as string | undefined,
                    startTime: new Date(start).toISOString(),
                    endTime: new Date(start + 55 * 60_000).toISOString(),
                    genres: [] as string[],
                    officialRating: undefined as string | undefined,
                };
            });

        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            programs: [...chain(0), ...chain(197)],
        });

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.programCount).toBe(3);
        // The collapse is routine feed noise: a note, not an operator warning.
        expect(result.notes.some((w) => w.includes('duplicate programme'))).toBe(true);
        expect(result.warnings.some((w) => w.includes('duplicate programme'))).toBe(false);

        // What lands in the DB must be a single non-overlapping schedule.
        const rows = insertedProgramRows(sql).map((r) => ({
            start: Date.parse(r.start_time as string),
            end: Date.parse(r.end_time as string),
        }));
        rows.sort((a, b) => a.start - b.start);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i].start).toBeGreaterThanOrEqual(rows[i - 1].end);
        }
    });

    it('does not drop genuine repeats that never overlap', async () => {
        const at = (hour: number, title: string) => ({
            channelId: 'News.de',
            title,
            description: undefined as string | undefined,
            startTime: new Date(Date.UTC(2026, 6, 28, hour, 0, 0)).toISOString(),
            endTime: new Date(Date.UTC(2026, 6, 28, hour, 55, 0)).toISOString(),
            genres: [] as string[],
            officialRating: undefined as string | undefined,
        });

        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            programs: [
                at(12, 'Nachrichtenblick'),
                at(16, 'Nachrichtenblick'),
                at(20, 'Nachrichtenblick'),
            ],
        });

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.programCount).toBe(3);
        expect(result.warnings).toEqual([]);
    });

    it('collects EPG parse warnings into the result', async () => {
        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            warnings: [
                {
                    element: 'programme',
                    field: 'desc',
                    message: 'Missing description for "Morning News"',
                },
            ],
        });

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('EPG:');
        expect(result.warnings[0]).toContain('Missing description');
    });

    it('fills a missing channel logo from the matched guide channel icon', async () => {
        const withLogo = {
            ...makeDbChannel('ch-uuid-2', 'Sport'),
            logo_url: 'http://playlist/sport.png',
        };
        mockGetChannelsBySourceId.mockResolvedValue([makeDbChannel('ch-uuid-1', 'News'), withLogo]);
        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            channels: [
                { id: 'News.de', displayName: 'News', iconUrl: 'http://guide/news.png' },
                { id: 'Sport.de', displayName: 'Sport', iconUrl: 'http://guide/sport.png' },
            ],
        });
        const both = makeEpgMatchResult(0, 'News.de');
        both.matches.push({ ...both.matches[0], channelIndex: 1, epgChannelId: 'Sport.de' });
        mockMatchEpgChannels.mockReturnValue(both);

        await importEpgSource(sql, SOURCE_ID);

        const calls = (sql as unknown as { __txCalls: unknown[][] }).__txCalls;
        const logoCall = calls.find(([strings]) =>
            (strings as string[]).join('?').includes('custom_poster_url = data.icon'),
        );
        expect(logoCall).toBeDefined();
        // Only the channel without a playlist logo is filled.
        expect(logoCall![1]).toEqual(['ch-uuid-1']);
        expect(logoCall![2]).toEqual(['http://guide/news.png']);
        // The other qualities of the station take the logo too (step 7e).
        expect(vi.mocked(shareBackupGroupLogos)).toHaveBeenCalledWith(expect.anything(), SOURCE_ID);
    });

    it('fills logos only from confident matches and http(s) icons, treating blank logos as empty', async () => {
        mockGetChannelsBySourceId.mockResolvedValue([
            { ...makeDbChannel('ch-1', 'News'), logo_url: '   ' }, // blank: filled
            makeDbChannel('ch-2', 'Sport'), // weak match: skipped
            makeDbChannel('ch-3', 'Film'), // data: icon: skipped
            makeDbChannel('ch-4', 'Kids'), // guide channel has no icon: skipped
        ]);
        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            channels: [
                { id: 'News.de', displayName: 'News', iconUrl: ' https://guide/news.png ' },
                { id: 'Sport.de', displayName: 'Sport', iconUrl: 'https://guide/sport.png' },
                { id: 'Film.de', displayName: 'Film', iconUrl: 'data:image/png;base64,AAAA' },
                { id: 'Kids.de', displayName: 'Kids', iconUrl: undefined },
            ],
        });
        const result = makeEpgMatchResult(0, 'News.de');
        const base = result.matches[0];
        result.matches.push(
            { ...base, channelIndex: 1, epgChannelId: 'Sport.de', confidence: 0.6 },
            { ...base, channelIndex: 2, epgChannelId: 'Film.de' },
            { ...base, channelIndex: 3, epgChannelId: 'Kids.de' },
        );
        mockMatchEpgChannels.mockReturnValue(result);

        await importEpgSource(sql, SOURCE_ID);

        const calls = (sql as unknown as { __txCalls: unknown[][] }).__txCalls;
        const logoCalls = calls.filter(([strings]) =>
            (strings as string[]).join('?').includes('custom_poster_url = data.icon'),
        );
        expect(logoCalls).toHaveLength(1);
        expect(logoCalls[0][1]).toEqual(['ch-1']);
        expect(logoCalls[0][2]).toEqual(['https://guide/news.png']);
        // The SQL itself keeps playlist logos and admin-pinned matches.
        const text = (logoCalls[0][0] as string[]).join('?');
        expect(text).toContain("btrim(mi.custom_poster_url) = ''");
        expect(text).toContain('epg_manual_override IS TRUE');
    });

    it('counts duplicate channel ids on one line and caps the rest', async () => {
        const dup = (i: number) => ({
            element: 'channel',
            field: 'id',
            kind: 'duplicate-channel-id' as const,
            message: `Duplicate channel ID: "ch${i}.de" (displayName="Ch ${i} HD")`,
        });
        const other = (i: number) => ({
            element: 'programme',
            field: 'desc',
            message: `Missing description ${i}`,
        });
        mockParseXmltv.mockReturnValue({
            ...makeXmltvResult(),
            warnings: [
                ...Array.from({ length: 3000 }, (_, i) => dup(i)),
                ...Array.from({ length: 150 }, (_, i) => other(i)),
            ],
        });

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.notes[0]).toBe("EPG: 3000 guide channels reuse another channel's ID");
        expect(result.notes).toHaveLength(1);
        expect(result.warnings.filter((w) => w.includes('Duplicate channel ID'))).toEqual([]);
        // 100 listed + the overflow line naming the 50 not listed (the cap is warnings-only).
        expect(result.warnings).toHaveLength(101);
        expect(result.warnings.at(-2)).toBe('EPG: Missing description 99');
        expect(result.warnings.at(-1)).toBe('... and 50 more warnings');
    });

    it('routes routine guide noise to notes and keeps real problems in warnings', async () => {
        // Real parser, real refresh-summary write: a duplicate channel id, a
        // 6000-char description and a zero-length programme are all routine.
        const { parseXmltv: parseXmltvActual } =
            await vi.importActual<typeof import('./xmltv-parser.js')>('./xmltv-parser.js');
        mockParseXmltv.mockImplementation(parseXmltvActual);
        const longDesc = 'Lorem ipsum dolor sit amet. '.repeat(240); // 6480 chars
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="News.de"><display-name>News</display-name></channel>
  <channel id="News.de"><display-name>News HD</display-name></channel>
  <programme start="20260728120000 +0000" stop="20260728130000 +0000" channel="News.de">
    <title>Long Show</title>
    <desc>${longDesc}</desc>
  </programme>
  <programme start="20260728130000 +0000" stop="20260728130000 +0000" channel="News.de">
    <title>Zero Length</title>
  </programme>
</tv>`;
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(xml),
        } as Response);

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.notes).toEqual([
            "EPG: 1 guide channel reuses another channel's ID",
            'EPG: Truncated 1 long programme description',
            'EPG: Skipped 1 programme with a zero-length time range',
        ]);
        expect(result.warnings).toEqual([]);
        const summary = vi.mocked(updateEpgRefreshStatus).mock.calls.at(-1)?.[3];
        expect(summary).toMatchObject({
            notes: result.notes,
            warnings: [],
            truncatedDescriptions: 1,
            skippedZeroDuration: 1,
            skippedInvertedRange: 0,
        });
    });

    it("passes each channel's stored country and backup group to the matcher", async () => {
        mockGetChannelsBySourceId.mockResolvedValue([
            { ...makeDbChannel('ch-1', 'TORQ FHD'), country_code: 'de', backup_group_id: 'g-1' },
            makeDbChannel('ch-2', 'News'),
        ]);

        await importEpgSource(sql, SOURCE_ID);

        const channels = mockMatchEpgChannels.mock.calls[0][0];
        expect(channels.map((c) => [c.region, c.backupGroupKey])).toEqual([
            ['de', 'g-1'],
            [undefined, undefined],
        ]);
    });

    it('reports throttled matching progress and stops on a cancel from it', async () => {
        const mod = await import('./epg-matcher.js');
        const asyncMock = vi.mocked(mod.matchEpgChannelsAsync);
        asyncMock.mockImplementationOnce(async (channels, epg, onProgress) => {
            await onProgress?.({ processed: 1, total: 3 });
            await onProgress?.({ processed: 2, total: 3 }); // within 1 s: throttled
            return mod.matchEpgChannels(channels, epg);
        });
        const progress = vi.fn().mockResolvedValue(undefined);

        await importEpgSource(sql, SOURCE_ID, progress);

        // The matcher's own calls (total 3); the phase opens with a 0/1 call.
        const matching = progress.mock.calls.filter(
            ([p]) => p.phase === 'matching' && p.total === 3,
        );
        expect(matching).toHaveLength(1);
        expect(matching[0][0]).toMatchObject({ processed: 1, total: 3 });

        vi.mocked(updateEpgRefreshStatus).mockClear();
        asyncMock.mockImplementationOnce(async (channels, epg, onProgress) => {
            await onProgress?.({ processed: 1, total: 3 });
            return mod.matchEpgChannels(channels, epg);
        });
        const cancelling = vi.fn(async (p: { phase: string }) => {
            if (p.phase === 'matching') throw new Error('Cancelled by admin');
        });
        await expect(importEpgSource(sql, SOURCE_ID, cancelling)).rejects.toThrow(
            'Cancelled by admin',
        );
        expect(vi.mocked(updateEpgRefreshStatus)).not.toHaveBeenCalledWith(
            sql,
            SOURCE_ID,
            'success',
            expect.anything(),
        );
    });

    it('throws when source has no XMLTV URL', async () => {
        mockGetSource.mockResolvedValue(makeSource({ xmltv_url: null }));

        await expect(importEpgSource(sql, SOURCE_ID)).rejects.toThrow(
            `Source ${SOURCE_ID} has no XMLTV URL`,
        );
    });

    it('handles zero matches gracefully without inserting programs', async () => {
        mockMatchEpgChannels.mockReturnValue({
            matches: [],
            unmatched: [
                {
                    channelIndex: 0,
                    channelName: 'News',
                    tvgId: 'News.de',
                    bestCandidate: undefined,
                    reason: 'no match found',
                },
            ],
            stats: {
                totalChannels: 1,
                matched: 0,
                unmatched: 1,
                bySignal: {
                    tvg_id_exact: 0,
                    tvg_id_partial: 0,
                    tvg_name_match: 0,
                    name_exact: 0,
                    name_fuzzy: 0,
                    group_title: 0,
                    backup_propagation: 0,
                },
                averageConfidence: 0,
            },
            warnings: [],
        });

        const result = await importEpgSource(sql, SOURCE_ID);

        expect(result.epgMatchCount).toBe(0);
        expect(result.programCount).toBe(0);
        // EPG channel upsert may still happen (persisting XMLTV channels is correct),
        // but no program INSERT should occur. Verify via programCount = 0 above.
        // sql is called for EPG channel upsert even with zero matches — that's intentional.
    });

    it('calls updateRefreshStatus with success after EPG import', async () => {
        await importEpgSource(sql, SOURCE_ID);

        expect(vi.mocked(updateEpgRefreshStatus)).toHaveBeenCalledWith(
            sql,
            SOURCE_ID,
            'success',
            expect.objectContaining({
                epgMatchCount: 1,
            }),
        );
    });

    it('leaves the source status alone when the source has no channels', async () => {
        // The M3U import failed first and recorded 'failed'; an EPG run over
        // zero channels must not overwrite that with 'success'.
        mockGetChannelsBySourceId.mockResolvedValue([]);
        mockMatchEpgChannels.mockReturnValue({
            ...makeEpgMatchResult(0, 'News.de'),
            matches: [],
            stats: { ...makeEpgMatchResult(0, 'News.de').stats, totalChannels: 0, matched: 0 },
        });

        await importEpgSource(sql, SOURCE_ID);

        expect(vi.mocked(updateEpgRefreshStatus)).not.toHaveBeenCalled();
    });
});
