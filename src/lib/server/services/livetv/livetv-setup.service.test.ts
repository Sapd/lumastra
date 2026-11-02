// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for livetv-setup.service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

// =============================================================================
// Mock the query module before importing the service
// =============================================================================

const mockGetChannelsForSetup = vi.fn();
const mockGetCategoriesForOrdering = vi.fn();
const mockBulkUpdateChannelVisibility = vi.fn();
const mockBulkUpdateChannelSortOrder = vi.fn();
const mockBulkUpdateCategorySortOrder = vi.fn();
const mockSaveSourceLineupFilter = vi.fn();

vi.mock('$lib/server/database/queries/livetv-setup.queries.js', () => ({
    getChannelsForSetup: mockGetChannelsForSetup,
    getCategoriesForOrdering: mockGetCategoriesForOrdering,
    bulkUpdateChannelVisibility: mockBulkUpdateChannelVisibility,
    bulkUpdateChannelSortOrder: mockBulkUpdateChannelSortOrder,
    bulkUpdateCategorySortOrder: mockBulkUpdateCategorySortOrder,
    saveSourceLineupFilter: mockSaveSourceLineupFilter,
}));

// Import after mocks are set up.
const { applySetupPreferences } = await import('./livetv-setup.service.js');

// =============================================================================
// Helpers
// =============================================================================

function makeSql(): postgres.Sql {
    const mock = {
        begin: vi.fn(async (fn: (tx: unknown) => Promise<void>) => {
            await fn(mock);
        }),
    };
    return mock as unknown as postgres.Sql;
}

function makeChannel(
    overrides: Partial<{
        id: string;
        title: string;
        quality_tier: string | null;
        is_visible: boolean;
        sort_order: number;
        playlist_index: number | null;
        country_code: string | null;
        category_name: string | null;
        backup_group_id: string | null;
        epg_channel_id: string | null;
        is_primary: boolean;
    }> = {},
) {
    return {
        id: 'uuid-ch-1',
        title: 'KWF',
        quality_tier: 'fhd',
        is_visible: true,
        sort_order: 0,
        playlist_index: null,
        country_code: null,
        category_name: 'News',
        backup_group_id: null,
        epg_channel_id: null,
        is_primary: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCategoriesForOrdering.mockResolvedValue([]);
    mockBulkUpdateChannelVisibility.mockResolvedValue(undefined);
    mockBulkUpdateChannelSortOrder.mockResolvedValue(undefined);
    mockBulkUpdateCategorySortOrder.mockResolvedValue(undefined);
});

// =============================================================================
// No channels
// =============================================================================

describe('applySetupPreferences — no channels', () => {
    it('returns success with zeros when no channels found', async () => {
        mockGetChannelsForSetup.mockResolvedValue([]);

        const result = await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(result.success).toBe(true);
        expect(result.visibleChannels).toBe(0);
        expect(result.hiddenChannels).toBe(0);
    });

    it('does not call bulk update queries when there are no channels', async () => {
        mockGetChannelsForSetup.mockResolvedValue([]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(mockBulkUpdateChannelVisibility).not.toHaveBeenCalled();
        expect(mockBulkUpdateChannelSortOrder).not.toHaveBeenCalled();
    });
});

// =============================================================================
// Region filtering
// =============================================================================

describe('applySetupPreferences — region filtering', () => {
    it('keeps all channels visible when region is generic', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-1', country_code: 'de' }),
            makeChannel({ id: 'ch-2', country_code: 'at' }),
            makeChannel({ id: 'ch-3', country_code: 'ch' }),
        ]);

        const result = await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(result.visibleChannels).toBe(3);
        expect(result.hiddenChannels).toBe(0);
    });

    it('makes channels with matching country_code visible', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-de', title: 'LRV', country_code: 'de' }),
            makeChannel({ id: 'ch-at', title: 'OSK', country_code: 'at' }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const deChannel = visibilityCall.find((u) => u.id === 'ch-de');
        const atChannel = visibilityCall.find((u) => u.id === 'ch-at');

        expect(deChannel?.isVisible).toBe(true);
        expect(atChannel?.isVisible).toBe(false);
    });

    it('keeps channels with null country_code visible (pan-DACH)', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-pan', title: 'MUSA', country_code: null }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const panChannel = visibilityCall.find((u) => u.id === 'ch-pan');
        expect(panChannel?.isVisible).toBe(true);
    });

    it('hides regional variants from non-matching countries', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-de', title: 'Sport8', country_code: 'de' }),
            makeChannel({ id: 'ch-at', title: 'Sport8', country_code: 'at' }),
            makeChannel({ id: 'ch-ch', title: 'Sport8', country_code: 'ch' }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const deVariant = visibilityCall.find((u) => u.id === 'ch-de');
        const atVariant = visibilityCall.find((u) => u.id === 'ch-at');
        const chVariant = visibilityCall.find((u) => u.id === 'ch-ch');

        expect(deVariant?.isVisible).toBe(true);
        expect(atVariant?.isVisible).toBe(false);
        expect(chVariant?.isVisible).toBe(false);
    });

    it('hides a channel of a country that was not kept, whatever its name', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-kwf-at',
                title: 'KWF HD',
                country_code: 'at',
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const ch = visibilityCall.find((u) => u.id === 'ch-kwf-at');
        expect(ch?.isVisible).toBe(false);
    });
});

// =============================================================================
// Quality preference
// =============================================================================

describe('applySetupPreferences — quality preference', () => {
    it('hides lower-quality channels within the same backup group when preferHighQuality is true', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-uhd',
                title: 'VDD',
                quality_tier: 'uhd',
                backup_group_id: 'bg-1',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-fhd',
                title: 'VDD',
                quality_tier: 'fhd',
                backup_group_id: 'bg-1',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-hd',
                title: 'VDD',
                quality_tier: 'hd',
                backup_group_id: 'bg-1',
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: true,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const uhd = visibilityCall.find((u) => u.id === 'ch-uhd');
        const fhd = visibilityCall.find((u) => u.id === 'ch-fhd');
        const hd = visibilityCall.find((u) => u.id === 'ch-hd');

        expect(uhd?.isVisible).toBe(true);
        expect(fhd?.isVisible).toBe(false);
        expect(hd?.isVisible).toBe(false);
    });

    it('leaves all channels in backup groups visible when preferHighQuality is false', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-uhd',
                title: 'VDD',
                quality_tier: 'uhd',
                backup_group_id: 'bg-1',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-hd',
                title: 'VDD',
                quality_tier: 'hd',
                backup_group_id: 'bg-1',
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const uhd = visibilityCall.find((u) => u.id === 'ch-uhd');
        const hd = visibilityCall.find((u) => u.id === 'ch-hd');

        expect(uhd?.isVisible).toBe(true);
        expect(hd?.isVisible).toBe(true);
    });

    it('does not affect channels without a backup_group_id', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-1',
                title: 'Standalone',
                quality_tier: 'sd',
                backup_group_id: null,
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: true,
        });

        const visibilityCall = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        const ch = visibilityCall.find((u) => u.id === 'ch-1');
        expect(ch?.isVisible).toBe(true);
    });
});

// =============================================================================
// Channel ordering
// =============================================================================

describe('applySetupPreferences — channel ordering', () => {
    it('assigns lower sort orders to sports channels in sports-first mode', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-news',
                title: 'VDD',
                category_name: 'news',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-sports',
                title: 'VELO',
                category_name: 'sports',
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'sports-first',
            preferHighQuality: false,
        });

        const sortCall = mockBulkUpdateChannelSortOrder.mock.calls[0][1] as Array<{
            id: string;
            sortOrder: number;
        }>;
        const sports = sortCall.find((u) => u.id === 'ch-sports');
        const news = sortCall.find((u) => u.id === 'ch-news');

        expect(sports!.sortOrder).toBeLessThan(news!.sortOrder);
    });

    it('assigns lower sort orders to news channels in traditional mode', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-sports',
                title: 'VELO',
                category_name: 'sports',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-news',
                title: 'VDD',
                category_name: 'news',
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const sortCall = mockBulkUpdateChannelSortOrder.mock.calls[0][1] as Array<{
            id: string;
            sortOrder: number;
        }>;
        const sports = sortCall.find((u) => u.id === 'ch-sports');
        const news = sortCall.find((u) => u.id === 'ch-news');

        expect(news!.sortOrder).toBeLessThan(sports!.sortOrder);
    });

    it('preserves the playlist (import) order within the same category', async () => {
        // KWF appears before LRV in the source playlist (lower import sort_order),
        // even though LRV sorts first alphabetically. Playlist order must win.
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-z',
                title: 'KWF',
                category_name: 'news',
                sort_order: 0,
                country_code: null,
            }),
            makeChannel({
                id: 'ch-a',
                title: 'LRV',
                category_name: 'news',
                sort_order: 1,
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const sortCall = mockBulkUpdateChannelSortOrder.mock.calls[0][1] as Array<{
            id: string;
            sortOrder: number;
        }>;
        const lrv = sortCall.find((u) => u.id === 'ch-a');
        const kwf = sortCall.find((u) => u.id === 'ch-z');

        expect(kwf!.sortOrder).toBeLessThan(lrv!.sortOrder);
    });

    it('orders within a category by playlist_index, overriding a mutated sort_order', async () => {
        // A prior wizard run alphabetized sort_order (LRV=0, KWF=1), but the
        // immutable playlist_index still reflects the source order (KWF before LRV).
        // playlist_index must win.
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-a',
                title: 'LRV',
                category_name: 'news',
                sort_order: 0,
                playlist_index: 5,
                country_code: null,
            }),
            makeChannel({
                id: 'ch-z',
                title: 'KWF',
                category_name: 'news',
                sort_order: 1,
                playlist_index: 2,
                country_code: null,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const sortCall = mockBulkUpdateChannelSortOrder.mock.calls[0][1] as Array<{
            id: string;
            sortOrder: number;
        }>;
        const lrv = sortCall.find((u) => u.id === 'ch-a');
        const kwf = sortCall.find((u) => u.id === 'ch-z');

        expect(kwf!.sortOrder).toBeLessThan(lrv!.sortOrder);
    });
});

// =============================================================================
// Category ordering
// =============================================================================

describe('applySetupPreferences — category ordering', () => {
    it('orders by the preset, puts provider bouquets at "other" and opt-in genres last', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-1', category_name: 'Sports', country_code: null }),
        ]);
        mockGetCategoriesForOrdering.mockResolvedValue([
            { id: 'cat-adult', name: 'Adult', sort_order: 0 },
            { id: 'cat-eis2', name: 'EIS2', sort_order: 1 },
            { id: 'cat-orb', name: 'Orb', sort_order: 2 },
            { id: 'cat-movies', name: 'Movies', sort_order: 3 },
            { id: 'cat-sports', name: 'Sports', sort_order: 4 },
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'sports-first',
            preferHighQuality: false,
        });

        const catCall = mockBulkUpdateCategorySortOrder.mock.calls[0][1] as Array<{
            id: string;
            sortOrder: number;
        }>;
        const order = [...catCall].sort((a, b) => a.sortOrder - b.sortOrder).map((c) => c.id);

        // Sports, Movies (preset), then the bouquets in their old order, Adult last.
        expect(order).toEqual(['cat-sports', 'cat-movies', 'cat-eis2', 'cat-orb', 'cat-adult']);
    });
});

// =============================================================================
// Result summary
// =============================================================================

describe('applySetupPreferences — result summary', () => {
    it('returns correct visible and hidden counts', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-1', country_code: 'de' }),
            makeChannel({ id: 'ch-2', country_code: 'at' }),
            makeChannel({ id: 'ch-3', country_code: null }),
        ]);

        const result = await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(result.visibleChannels).toBe(2);
        expect(result.hiddenChannels).toBe(1);
        expect(result.success).toBe(true);
    });

    it('counts distinct categories in the result', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'ch-1',
                category_name: 'News',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-2',
                category_name: 'Sports',
                country_code: null,
            }),
            makeChannel({
                id: 'ch-3',
                category_name: 'News',
                country_code: null,
            }),
        ]);

        const result = await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(result.categories).toBe(2);
    });

    it('calls both bulk update functions', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ch-1', country_code: null }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        expect(mockBulkUpdateChannelVisibility).toHaveBeenCalledOnce();
        expect(mockBulkUpdateChannelSortOrder).toHaveBeenCalledOnce();
        expect(mockBulkUpdateCategorySortOrder).toHaveBeenCalledOnce();
    });
});

// =============================================================================
// Multi-country lineup filter
// =============================================================================

describe('applySetupPreferences — countries, 24/7 and categories', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCategoriesForOrdering.mockResolvedValue([]);
    });

    function visibility(): Map<string, boolean> {
        const updates = mockBulkUpdateChannelVisibility.mock.calls[0][1] as Array<{
            id: string;
            isVisible: boolean;
        }>;
        return new Map(updates.map((u) => [u.id, u.isVisible]));
    }

    it('keeps several countries at once and hides 24/7 and hidden categories', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'de', title: 'Nordwelle', country_code: 'de' }),
            makeChannel({ id: 'at', title: 'OSK 1', country_code: 'at' }),
            makeChannel({ id: 'uk', title: 'UK: WBN 1', country_code: 'uk' }),
            makeChannel({ id: 'us', title: 'US: VDD', country_code: 'us' }),
            makeChannel({ id: 'ro', title: 'RO: Pro TV', country_code: 'ro' }),
            makeChannel({ id: 'tr', title: 'TR: KZK 1', country_code: 'tr' }),
            makeChannel({ id: 'loop', title: '24/7 • Seabright', country_code: null }),
            makeChannel({ id: 'untagged', title: 'Orb One', country_code: null }),
            makeChannel({
                id: 'shop',
                title: 'KAUFRING',
                country_code: 'de',
                category_name: 'Shopping',
            }),
        ]);

        const result = await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            countries: ['de', 'at', 'uk', 'us'],
            hideLoopChannels: true,
            hiddenCategories: ['Shopping'],
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const v = visibility();
        expect(
            [...v]
                .filter(([, keep]) => keep)
                .map(([id]) => id)
                .sort(),
        ).toEqual(['at', 'de', 'uk', 'untagged', 'us'].sort());
        expect(result.visibleChannels).toBe(5);
        expect(mockSaveSourceLineupFilter).toHaveBeenCalledWith(expect.anything(), 'uuid-src-1', {
            countries: ['de', 'at', 'uk', 'us'],
            includeUntagged: true,
            hideLoopChannels: true,
            hiddenCategories: ['Shopping'],
            channelOrder: 'traditional',
            preferHighQuality: false,
        });
    });

    it('hides the noise kinds whose switches are on, found across the lineup', async () => {
        const slots = Array.from({ length: 6 }, (_, i) =>
            makeChannel({
                id: `slot-${i + 1}`,
                title: `Korira Event ${i + 1}`,
                category_name: 'Live Events',
            }),
        );
        const locals = ['KAAA', 'KBBB', 'KCCC', 'WDDD', 'WEEE', 'WFFF', 'KGGG', 'WHHH'].map(
            (sign, i) =>
                makeChannel({
                    id: `local-${sign}`,
                    title: `US: KVL - ST - Town ${String.fromCharCode(65 + i)} (${sign})`,
                    country_code: 'us',
                    category_name: 'Regional',
                }),
        );
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'station', title: 'Nordwelle', epg_channel_id: 'nordwelle.de' }),
            makeChannel({ id: 'info', title: 'Korira Event Info', category_name: 'Live Events' }),
            makeChannel({ id: 'radio', title: 'Hafenwelle 2', category_name: 'Radio' }),
            makeChannel({ id: 'film', title: 'Ein Film (1998)', category_name: 'Movies' }),
            ...slots,
            ...locals,
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            hideLoopChannels: true,
            hideInfoChannels: true,
            hideLocalStations: true,
            hideRadio: true,
            channelOrder: 'traditional',
            preferHighQuality: false,
        });

        const visible = [...visibility()].filter(([, keep]) => keep).map(([id]) => id);
        // Event slots stay: their switch is off.
        expect(visible.sort()).toEqual(['station', ...slots.map((s) => s.id)].sort());
        // Chosen switches are stored; the one never sent stays unstored.
        const stored = mockSaveSourceLineupFilter.mock.calls[0][2];
        expect(stored).toMatchObject({
            hideInfoChannels: true,
            hideLocalStations: true,
            hideRadio: true,
        });
        expect(stored).not.toHaveProperty('hideEventSlots');
    });

    it('keeps the group primary when another feed has the same quality tier', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'plus',
                title: 'Siebenstern FHD+',
                quality_tier: 'fhd',
                backup_group_id: 'g',
                sort_order: 1,
            }),
            makeChannel({
                id: 'fhd',
                title: 'Siebenstern FHD',
                quality_tier: 'fhd',
                backup_group_id: 'g',
                sort_order: 2,
                is_primary: true,
            }),
            makeChannel({
                id: 'raw',
                title: 'Siebenstern HDraw',
                quality_tier: 'hd',
                backup_group_id: 'g',
                sort_order: 3,
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            channelOrder: 'traditional',
            preferHighQuality: true,
        });

        // Viewers see a group through its primary: hiding it dropped the station.
        expect(visibility().get('fhd')).toBe(true);
        expect(visibility().get('plus')).toBe(false);
        expect(visibility().get('raw')).toBe(false);
    });

    it('lets a transcoded primary yield to a normal feed', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'tr',
                title: 'Station FHD (Transcoded)',
                quality_tier: 'fhd',
                backup_group_id: 'g',
                is_primary: true,
            }),
            makeChannel({
                id: 'hd',
                title: 'Station HD',
                quality_tier: 'hd',
                backup_group_id: 'g',
            }),
        ]);
        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            channelOrder: 'traditional',
            preferHighQuality: true,
        });
        expect(visibility().get('hd')).toBe(true);
        expect(visibility().get('tr')).toBe(false);
    });

    it('does not re-show a group member the filter dropped when another member is kept', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'raw',
                title: '3kult HDraw',
                country_code: 'de',
                backup_group_id: 'g',
                quality_tier: 'hd',
            }),
            makeChannel({
                id: 'fhd',
                title: '3kult FHD',
                country_code: null,
                backup_group_id: 'g',
                quality_tier: 'fhd',
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            countries: ['de'],
            includeUntagged: false,
            channelOrder: 'traditional',
            preferHighQuality: true,
        });

        expect(visibility().get('raw')).toBe(true);
        expect(visibility().get('fhd')).toBe(false);
    });

    it('keeps the kept feed when the filtered primary is in another country', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({
                id: 'at',
                title: 'AT: Siebenstern',
                country_code: 'at',
                backup_group_id: 'g',
                quality_tier: 'fhd',
                is_primary: true,
            }),
            makeChannel({
                id: 'de',
                title: 'DE: Siebenstern',
                country_code: 'de',
                backup_group_id: 'g',
                quality_tier: 'hd',
            }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            countries: ['de'],
            includeUntagged: false,
            channelOrder: 'traditional',
            preferHighQuality: true,
        });

        // The excluded primary used to be widened back in and then win the
        // quality step, leaving the group with no feed viewers can have.
        expect(visibility().get('de')).toBe(true);
        expect(visibility().get('at')).toBe(false);
    });

    it('countries win over the legacy region; generic stores an empty country list', async () => {
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'de', title: 'LRV', country_code: 'de' }),
            makeChannel({ id: 'uk', title: 'WBN', country_code: 'uk' }),
        ]);

        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'de',
            countries: ['uk'],
            channelOrder: 'traditional',
            preferHighQuality: false,
        });
        expect(visibility().get('de')).toBe(false);
        expect(visibility().get('uk')).toBe(true);

        vi.clearAllMocks();
        mockGetCategoriesForOrdering.mockResolvedValue([]);
        mockGetChannelsForSetup.mockResolvedValue([
            makeChannel({ id: 'ro', title: 'RO', country_code: 'ro' }),
        ]);
        await applySetupPreferences(makeSql(), {
            sourceId: 'uuid-src-1',
            region: 'generic',
            channelOrder: 'traditional',
            preferHighQuality: false,
        });
        expect(visibility().get('ro')).toBe(true);
        expect(mockSaveSourceLineupFilter.mock.calls[0][2]).toMatchObject({ countries: [] });
    });
});
