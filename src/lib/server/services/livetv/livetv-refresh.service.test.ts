// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { RefreshResult } from './livetv-refresh.service.js';

// This isolated service fixture uses the disconnected memory-lock primitive.
vi.hoisted(() => vi.stubEnv('TASK_CACHE_URL', ''));
afterAll(() => vi.unstubAllEnvs());

// Mock dependencies before importing the module under test
vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: vi.fn().mockResolvedValue({ valid: true, resolvedIp: '127.0.0.1' }),
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
    config: { LIVETV_ALLOW_PRIVATE_URLS: true, LIVETV_UPSTREAM_PROXY_URL: '' },
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

vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    getSourceByIdWithCredentials: vi.fn(),
    updateRefreshStatus: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getChannelsForRefresh: vi.fn(),
    updateMatchedChannels: vi.fn().mockResolvedValue(0),
    bulkUpdateChannelAbsences: vi.fn().mockResolvedValue(0),
    archiveStaleChannels: vi.fn().mockResolvedValue(0),
    purgeArchivedChannels: vi.fn().mockResolvedValue(0),
    purgeEmptyCategories: vi.fn().mockResolvedValue(0),
    shareBackupGroupLogos: vi.fn().mockResolvedValue(0),
    bulkCreateChannels: vi.fn().mockResolvedValue({
        channelCount: 0,
        categoryCount: 0,
        backupGroupCount: 0,
    }),
}));

vi.mock('$lib/server/database/queries/livetv-setup.queries.js', () => ({
    getSourceLineupFilter: vi.fn().mockResolvedValue(null),
    bulkUpdateChannelVisibility: vi.fn().mockResolvedValue(undefined),
    getChannelsForSetup: vi.fn().mockResolvedValue([]),
}));

// Must import after mocks
const { refreshM3uSource } = await import('./livetv-refresh.service.js');
const { fetchSsrfValidatedText, M3U_MAX_FETCH_BYTES } = await import('./fetch-source.js');
const { getSourceByIdWithCredentials } =
    await import('$lib/server/database/queries/livetv-sources.queries.js');
const {
    getChannelsForRefresh,
    updateMatchedChannels,
    bulkUpdateChannelAbsences,
    archiveStaleChannels,
    purgeArchivedChannels,
    purgeEmptyCategories,
    bulkCreateChannels,
    shareBackupGroupLogos,
} = await import('$lib/server/database/queries/livetv-channels.queries.js');
const { getSourceLineupFilter, bulkUpdateChannelVisibility, getChannelsForSetup } =
    await import('$lib/server/database/queries/livetv-setup.queries.js');

// Sample M3U content
const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="Nordwelle.de" tvg-name="Nordwelle HD" tvg-logo="http://logo.com/1.png" group-title="Free TV",Nordwelle HD
http://provider.com/live/user/pass/12345.ts
#EXTINF:-1 tvg-id="KWF.de" tvg-name="KWF HD" tvg-logo="http://logo.com/2.png" group-title="Free TV",KWF HD
http://provider.com/live/user/pass/67890.ts
#EXTINF:-1 tvg-id="MTK.de" tvg-name="MTK HD" tvg-logo="http://logo.com/3.png" group-title="Entertainment",MTK HD
http://provider.com/live/user/pass/11111.ts
`;

// Existing DB channels
function makeDbChannels() {
    return [
        {
            id: 'ch-1',
            name: 'Nordwelle HD',
            stream_url: 'http://old-cdn.com/live/user/pass/12345.ts',
            logo_url: 'http://logo.com/1.png',
            quality_tier: 'hd',
            epg_channel_id: 'Nordwelle.de',
            sort_order: 0,
            is_visible: true,
            category_id: 'cat-1',
            category_name: 'free-tv',
            backup_group_id: null,
            source_id: 'src-1',
            country_code: 'de',
            consecutive_absences: 0,
            created_at: new Date(),
        },
        {
            id: 'ch-2',
            name: 'KWF HD',
            stream_url: 'http://provider.com/live/user/pass/67890.ts',
            logo_url: 'http://logo.com/2.png',
            quality_tier: 'hd',
            epg_channel_id: 'KWF.de',
            sort_order: 1,
            is_visible: true,
            category_id: 'cat-1',
            category_name: 'free-tv',
            backup_group_id: null,
            source_id: 'src-1',
            country_code: 'de',
            consecutive_absences: 0,
            created_at: new Date(),
        },
        {
            id: 'ch-3',
            name: 'Siebenstern HD',
            stream_url: 'http://provider.com/live/user/pass/22222.ts',
            logo_url: 'http://logo.com/p7.png',
            quality_tier: 'hd',
            epg_channel_id: 'Siebenstern.de',
            sort_order: 2,
            is_visible: true,
            category_id: 'cat-2',
            category_name: 'entertainment',
            backup_group_id: null,
            source_id: 'src-1',
            country_code: 'de',
            consecutive_absences: 0,
            created_at: new Date(),
        },
    ];
}

// Mock fetch globally
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Fake sql transaction
function makeFakeSql() {
    const sql = vi.fn() as unknown as Record<string, unknown>;
    (sql as Record<string, unknown>).begin = vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
        await fn(sql);
    });
    (sql as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);
    return sql as unknown as postgres.Sql;
}

describe('refreshM3uSource', () => {
    let sql: postgres.Sql;

    beforeEach(() => {
        vi.clearAllMocks();
        sql = makeFakeSql();

        vi.mocked(getSourceByIdWithCredentials).mockResolvedValue({
            id: 'src-1',
            name: 'Test Source',
            source_type: 'm3u',
            m3u_url: 'http://provider.com/get.php?type=m3u_plus',
            xmltv_url: null,
            xtream_server: null,
            xtream_username: null,
            xtream_password: null,
            hdhomerun_device_ip: null,
            hdhomerun_device_id: null,
            max_streams: 1,
            refresh_cron: '0 */6 * * *',
            last_refresh_at: null,
            last_refresh_status: null,
            last_refresh_summary: null,
            created_at: new Date(),
            updated_at: new Date(),
        });

        vi.mocked(getChannelsForRefresh).mockResolvedValue(makeDbChannels());

        mockFetch.mockResolvedValue({
            ok: true,
            text: () => Promise.resolve(SAMPLE_M3U),
        });
    });

    it('fetches the playlist with the M3U byte ceiling', async () => {
        await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(fetchSsrfValidatedText)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSsrfValidatedText).mock.calls[0][1]).toMatchObject({
            maxBytes: M3U_MAX_FETCH_BYTES,
        });
    });

    it('matches existing channels and identifies new/removed', async () => {
        const result: RefreshResult = await refreshM3uSource(sql, 'src-1');

        // Nordwelle matched (tvg-id + url-id + name), KWF matched (tvg-id + url-id + name)
        // MTK is new, Siebenstern is removed
        expect(result.matched).toBe(2);
        expect(result.newChannels).toBe(1); // MTK HD
        expect(result.removedChannels).toBe(1); // Siebenstern HD
        expect(result.massRestructure).toBe(false);
    });

    it('preserves admin customizations on matched channels', async () => {
        await refreshM3uSource(sql, 'src-1');

        // updateMatchedChannels should be called — verify admin fields are NOT in the update
        expect(vi.mocked(updateMatchedChannels)).toHaveBeenCalled();
        const updates = vi.mocked(updateMatchedChannels).mock.calls[0][1];

        // Each update should only contain provider-controlled fields
        for (const update of updates) {
            expect(update).toHaveProperty('id');
            expect(update).toHaveProperty('streamUrl');
            expect(update).toHaveProperty('epgChannelId');
            // Admin fields should NOT be present
            expect(update).not.toHaveProperty('sortOrder');
            expect(update).not.toHaveProperty('isVisible');
            expect(update).not.toHaveProperty('adminDisplayName');
            expect(update).not.toHaveProperty('categoryId');
            expect(update).not.toHaveProperty('backupGroupId');
        }
    });

    it('inserts new channels via bulkCreateChannels', async () => {
        await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(bulkCreateChannels)).toHaveBeenCalled();
        const bulkData = vi.mocked(bulkCreateChannels).mock.calls[0][1];
        expect(bulkData.channels).toHaveLength(1); // MTK HD
        expect(bulkData.channels[0].name).toBe('MTK HD');
    });

    it('hides new channels the stored lineup filter would hide, and only those', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValueOnce({
            countries: ['uk'],
            includeUntagged: false,
            hideLoopChannels: false,
            hiddenCategories: [],
        });

        mockFetch.mockResolvedValue({
            ok: true,
            text: () =>
                Promise.resolve(
                    SAMPLE_M3U +
                        '#EXTINF:-1 tvg-id="WBNOne.uk" tvg-name="WBN One HD" group-title="UK",WBN One HD\n' +
                        'http://provider.com/live/user/pass/33333.ts\n',
                ),
        });

        const result = await refreshM3uSource(sql, 'src-1');

        // New: MTK HD (MTK.de, not kept) and WBN One HD (WBNOne.uk, kept).
        const bulkData = vi.mocked(bulkCreateChannels).mock.calls[0][1];
        const byName = new Map(bulkData.channels.map((c) => [c.name, c.id]));
        expect(byName.size).toBe(2);
        expect(vi.mocked(bulkUpdateChannelVisibility)).toHaveBeenCalledWith(expect.anything(), [
            { id: byName.get('MTK HD'), isVisible: false },
        ]);
        expect(result.lineupHidden).toBe(1);
        // Matched channels never get a visibility change from a refresh.
        const updates = vi.mocked(updateMatchedChannels).mock.calls[0][1];
        for (const update of updates) expect(update).not.toHaveProperty('isVisible');
    });

    it('hides new event slots by their family across the whole lineup', async () => {
        vi.mocked(getSourceLineupFilter).mockResolvedValueOnce({
            countries: [],
            includeUntagged: true,
            hideLoopChannels: false,
            hideEventSlots: true,
            hiddenCategories: [],
        });
        // The source already has slots 1-7; the refresh adds slot 8 and MTK HD.
        const existing = Array.from({ length: 7 }, (_, i) => ({
            id: `slot-${i + 1}`,
            title: `Korira Event ${i + 1}`,
            category_name: 'Live Events',
            epg_channel_id: null,
            playlist_index: i,
        }));
        vi.mocked(getChannelsForSetup).mockImplementationOnce(
            async () =>
                [
                    ...existing,
                    ...vi.mocked(bulkCreateChannels).mock.calls[0][1].channels.map((c, i) => ({
                        id: c.id,
                        title: c.name,
                        category_name: null,
                        epg_channel_id: null,
                        playlist_index: 100 + i,
                    })),
                ] as never,
        );
        mockFetch.mockResolvedValue({
            ok: true,
            text: () =>
                Promise.resolve(
                    SAMPLE_M3U +
                        '#EXTINF:-1 group-title="Events",Korira Event 8\n' +
                        'http://provider.com/live/user/pass/44444.ts\n',
                ),
        });

        const result = await refreshM3uSource(sql, 'src-1');

        const bulkData = vi.mocked(bulkCreateChannels).mock.calls[0][1];
        const slot = bulkData.channels.find((c) => c.name === 'Korira Event 8');
        expect(vi.mocked(bulkUpdateChannelVisibility)).toHaveBeenCalledWith(expect.anything(), [
            { id: slot?.id, isVisible: false },
        ]);
        expect(result.lineupHidden).toBe(1);
    });

    it('shares station logos across backup groups in the refresh transaction', async () => {
        await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(shareBackupGroupLogos)).toHaveBeenCalledWith(expect.anything(), 'src-1');
        expect(vi.mocked(bulkCreateChannels).mock.invocationCallOrder[0]).toBeLessThan(
            vi.mocked(shareBackupGroupLogos).mock.invocationCallOrder[0],
        );
    });

    it('leaves new channels visible without a stored lineup filter', async () => {
        const result = await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(bulkUpdateChannelVisibility)).not.toHaveBeenCalled();
        expect(result.lineupHidden).toBe(0);
    });

    it('persists backup groups for new channels (collapses FHD/HD variants)', async () => {
        // First-population scenario: no existing channels, so every parsed channel
        // is "new" and flows through the bulkCreateChannels path.
        vi.mocked(getChannelsForRefresh).mockResolvedValue([]);
        mockFetch.mockResolvedValue({
            ok: true,
            text: () =>
                Promise.resolve(`#EXTM3U
#EXTINF:-1 tvg-id="370" tvg-name="EKR Sachsen FHD" tvg-logo="http://logo/m.png" group-title="FreeTV / HD+",EKR Sachsen FHD
http://provider.com/live/user/pass/1.ts
#EXTINF:-1 tvg-id="370" tvg-name="EKR Sachsen HD" tvg-logo="http://logo/m.png" group-title="FreeTV / HD+",EKR Sachsen HD
http://provider.com/live/user/pass/2.ts
`),
        });

        await refreshM3uSource(sql, 'src-1');

        const bulkData = vi.mocked(bulkCreateChannels).mock.calls[0][1];
        expect(bulkData.channels).toHaveLength(2);

        // A backup group must be created and persisted (regression: was always []).
        expect(bulkData.backupGroups).toHaveLength(1);
        const group = bulkData.backupGroups[0];

        const fhd = bulkData.channels.find((c) => c.name === 'EKR Sachsen FHD');
        const hd = bulkData.channels.find((c) => c.name === 'EKR Sachsen HD');
        expect(fhd).toBeDefined();
        expect(hd).toBeDefined();

        // FHD is the higher quality → primary of the group.
        expect(group.primaryChannelId).toBe(fhd?.id);
        // Both variants reference the same group.
        expect(fhd?.backupGroupId).toBe(group.id);
        expect(hd?.backupGroupId).toBe(group.id);
    });

    it('does NOT create a competing group when the primary is a pre-existing channel', async () => {
        // Existing FHD (the group's primary) is already in the DB and will match.
        // Only the lower-quality HD/SD variants are new. We must NOT promote one of
        // them to primary of a new group — leave grouping to the matched FHD.
        vi.mocked(getChannelsForRefresh).mockResolvedValue([
            {
                id: 'ch-fhd',
                name: 'Nordwelle FHD',
                stream_url: 'http://provider.com/live/user/pass/100.ts',
                logo_url: null,
                quality_tier: 'fhd',
                epg_channel_id: 'Nordwelle.de',
                sort_order: 0,
                is_visible: true,
                category_id: 'cat-1',
                category_name: 'free-tv',
                backup_group_id: 'existing-group',
                source_id: 'src-1',
                country_code: 'de',
                consecutive_absences: 0,
                created_at: new Date(),
            },
        ]);
        mockFetch.mockResolvedValue({
            ok: true,
            text: () =>
                Promise.resolve(`#EXTM3U
#EXTINF:-1 tvg-id="Nordwelle.de" tvg-name="Nordwelle FHD" group-title="Free TV",Nordwelle FHD
http://provider.com/live/user/pass/100.ts
#EXTINF:-1 tvg-id="Nordwelle.de" tvg-name="Nordwelle HD" group-title="Free TV",Nordwelle HD
http://provider.com/live/user/pass/101.ts
#EXTINF:-1 tvg-id="Nordwelle.de" tvg-name="Nordwelle SD" group-title="Free TV",Nordwelle SD
http://provider.com/live/user/pass/102.ts
`),
        });

        await refreshM3uSource(sql, 'src-1');

        const bulkData = vi.mocked(bulkCreateChannels).mock.calls[0][1];
        // HD + SD are the new channels.
        expect(bulkData.channels).toHaveLength(2);
        // No competing group created; new variants stay ungrouped.
        expect(bulkData.backupGroups).toHaveLength(0);
        for (const ch of bulkData.channels) {
            expect(ch.backupGroupId).toBeUndefined();
        }
    });

    it('increments consecutive absences for removed channels', async () => {
        await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(bulkUpdateChannelAbsences)).toHaveBeenCalled();
        const updates = vi.mocked(bulkUpdateChannelAbsences).mock.calls[0][1];
        expect(updates).toHaveLength(1); // Siebenstern
        expect(updates[0].id).toBe('ch-3');
        expect(updates[0].absences).toBe(1); // was 0, now 1
    });

    it('archives channels with 3+ consecutive absences', async () => {
        await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(archiveStaleChannels)).toHaveBeenCalledWith(expect.anything(), 'src-1');
    });

    it('deletes channels gone for PURGE_AFTER_ABSENCES refreshes, then empty categories', async () => {
        vi.mocked(purgeArchivedChannels).mockResolvedValueOnce(2);
        const result = await refreshM3uSource(sql, 'src-1');

        expect(vi.mocked(purgeArchivedChannels)).toHaveBeenCalledWith(expect.anything(), null, {
            sourceId: 'src-1',
            minAbsences: 14,
        });
        expect(vi.mocked(purgeEmptyCategories)).toHaveBeenCalled();
        expect(result.deletedChannels).toBe(2);
    });

    it('detects mass restructure and does NOT hide old channels', async () => {
        // Return many existing channels that won't match
        vi.mocked(getChannelsForRefresh).mockResolvedValue([
            ...makeDbChannels(),
            ...Array.from({ length: 10 }, (_, i) => ({
                id: `ch-extra-${i}`,
                name: `Unknown Channel ${i}`,
                stream_url: `http://old.com/${i}.ts`,
                logo_url: null,
                quality_tier: null,
                epg_channel_id: `Unknown${i}.xx`,
                sort_order: 10 + i,
                is_visible: true,
                category_id: null,
                category_name: null,
                backup_group_id: null,
                source_id: 'src-1',
                country_code: null,
                consecutive_absences: 0,
                created_at: new Date(),
            })),
        ]);

        const result = await refreshM3uSource(sql, 'src-1');

        expect(result.massRestructure).toBe(true);
        // bulkUpdateChannelAbsences should NOT be called for mass restructure
        expect(vi.mocked(bulkUpdateChannelAbsences)).not.toHaveBeenCalled();
    });

    it('reports URL changes correctly', async () => {
        const result = await refreshM3uSource(sql, 'src-1');

        // Nordwelle has different URL (old-cdn vs provider)
        expect(result.urlChanges).toBeGreaterThanOrEqual(1);
    });

    it('handles fetch failure gracefully', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 });

        await expect(refreshM3uSource(sql, 'src-1')).rejects.toThrow(
            'Failed to fetch M3U: HTTP 503',
        );
    });

    it('handles source not found', async () => {
        vi.mocked(getSourceByIdWithCredentials).mockResolvedValue(null);

        await expect(refreshM3uSource(sql, 'missing')).rejects.toThrow('Source not found: missing');
    });
});
