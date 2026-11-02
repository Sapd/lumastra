// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /livetv/admin/sources/{sourceId}/setup: the noise counts come from the
 * lineup classification, and `savedSetup` names a noise switch only when the
 * stored choices have it (so Configure Lineup can offer its default).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockGetSql } = vi.hoisted(() => ({ mockGetSql: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));

const { mockGetSetupSummary, mockGetChannelsForSetup } = vi.hoisted(() => ({
    mockGetSetupSummary: vi.fn(),
    mockGetChannelsForSetup: vi.fn(),
}));
vi.mock('$lib/server/database/queries/livetv-setup.queries.js', () => ({
    getSetupSummary: (...args: unknown[]) => mockGetSetupSummary(...args),
    getChannelsForSetup: (...args: unknown[]) => mockGetChannelsForSetup(...args),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({ applySetupPreferences: vi.fn() }));
vi.mock('$lib/server/services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: vi.fn(),
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './setup.js';

const SOURCE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function makeEvent(): RequestEvent {
    const url = `http://localhost/api/v1/livetv/admin/sources/${SOURCE_ID}/setup`;
    return {
        url: new URL(url),
        request: new Request(url, { method: 'GET' }),
        params: { sourceId: SOURCE_ID },
        route: { id: '/api/v1/livetv/admin/sources/[id]/setup' as const },
        locals: { principal: { scopes: ['livetv:admin'] } },
        cookies: { get: vi.fn(), set: vi.fn() } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const row = (id: string, title: string, category_name: string | null = null) => ({
    id,
    title,
    category_name,
    epg_channel_id: null,
    playlist_index: null,
});

function summaryWith(lineupFilter: unknown) {
    return {
        summary: {
            total_channels: 9,
            visible_channels: 9,
            quality_uhd: 0,
            quality_fhd: 0,
            quality_hd: 0,
            quality_sd: 0,
            quality_unknown: 9,
            regional_variant_count: 0,
            untagged_channels: 9,
        },
        categories: [],
        detectedRegions: [],
        regions: [],
        lineupFilter,
    };
}

async function get(): Promise<Record<string, unknown>> {
    const { GET } = mount(def, { surface: 'v1' });
    const res = await GET!(makeEvent());
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
    mockGetChannelsForSetup.mockResolvedValue([
        row('radio', 'Hafenwelle', 'Radio'),
        row('info', 'Korira Event Info'),
        row('loop', '24/7 • Seabright'),
        ...Array.from({ length: 5 }, (_, i) => row(`slot${i}`, `Korira Event ${i + 1}`)),
    ]);
});

describe('GET setup — noise counts and saved switches', () => {
    it('counts each kind from the classified lineup', async () => {
        mockGetSetupSummary.mockResolvedValue(summaryWith(null));
        const body = await get();
        expect(body).toMatchObject({
            loopChannelCount: 1,
            infoChannelCount: 1,
            eventSlotCount: 5,
            localStationCount: 0,
            radioChannelCount: 1,
        });
        expect(body).not.toHaveProperty('savedSetup');
    });

    it('leaves out switches a filter stored before them never had', async () => {
        mockGetSetupSummary.mockResolvedValue(
            summaryWith({
                countries: ['de'],
                includeUntagged: true,
                hideLoopChannels: true,
                hiddenCategories: [],
            }),
        );
        const saved = (await get()).savedSetup as Record<string, unknown>;
        expect(saved).toMatchObject({ countries: ['de'], hideLoopChannels: true });
        for (const key of [
            'hideInfoChannels',
            'hideEventSlots',
            'hideLocalStations',
            'hideRadio',
        ]) {
            expect(saved).not.toHaveProperty(key);
        }
    });

    it('returns the stored switches as stored', async () => {
        mockGetSetupSummary.mockResolvedValue(
            summaryWith({
                countries: [],
                includeUntagged: true,
                hideLoopChannels: false,
                hideRadio: true,
                hideEventSlots: false,
                hiddenCategories: [],
                channelOrder: 'sports-first',
            }),
        );
        const saved = (await get()).savedSetup as Record<string, unknown>;
        expect(saved).toMatchObject({
            hideRadio: true,
            hideEventSlots: false,
            channelOrder: 'sports-first',
        });
        expect(saved).not.toHaveProperty('hideInfoChannels');
    });
});
