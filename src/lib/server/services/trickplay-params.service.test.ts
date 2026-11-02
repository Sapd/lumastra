// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrickplayParams } from '@sapd/lumastra-plugin-sdk';

const h = vi.hoisted(() => ({
    upsert: vi.fn(),
    discover: vi.fn(),
}));
vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
vi.mock('../database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: vi.fn(async () => ({ fileId: 'file-1', files: [] })),
}));
vi.mock('../database/queries/trickplay-params.queries.js', () => ({
    getTrickplayParams: vi.fn(async () => []),
    upsertTrickplayParams: h.upsert,
    deleteTrickplayParams: vi.fn(),
    toTrickplayInfo: vi.fn(),
}));
vi.mock('../tasks/registry.js', () => ({
    registry: {
        getAllTrickplays: () => [
            { id: 'jellyfin-disk-trickplay', fetchParams: vi.fn(), discoverParams: h.discover },
        ],
    },
}));
vi.mock('../tasks/plugin-context.js', () => ({ buildPluginContext: vi.fn(() => ({})) }));

import { trickplayParamsService } from './trickplay-params.service.js';

const base: TrickplayParams = {
    url: '/x',
    tileWidth: 10,
    tileHeight: 10,
    interval: 10000,
    columns: 10,
    rows: 10,
    thumbnailCount: 130,
};

beforeEach(() => {
    vi.clearAllMocks();
    h.upsert.mockResolvedValue(undefined);
});

describe('trickplay params height', () => {
    it('stores the provider-measured 4:3 height and marks it measured', async () => {
        h.discover.mockResolvedValue([{ width: 320, params: { ...base, thumbnailHeight: 240 } }]);

        const info = await trickplayParamsService.getParams('item-1');

        expect(info).toMatchObject({ width: 320, height: 240 });
        expect(info).not.toHaveProperty('heightMeasured');
        expect(h.upsert.mock.calls[0][3]).toEqual([
            expect.objectContaining({ width: 320, height: 240, heightMeasured: true }),
        ]);
    });

    it('falls back to 16:9 for providers without a height and leaves it unmeasured', async () => {
        h.discover.mockResolvedValue([{ width: 320, params: base }]);

        const info = await trickplayParamsService.getParams('item-1');

        expect(info?.height).toBe(180);
        expect(h.upsert.mock.calls[0][3]).toEqual([
            expect.objectContaining({ height: 180, heightMeasured: false }),
        ]);
    });
});
