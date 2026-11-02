// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A fresh install with a small library resolves none of the global
 * trending/popular titles. That is normal, so it must not surface as WARN, and
 * the (unused) description batch fetch must not run or fail at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
const debug = vi.fn();
const getList = vi.fn();
const getBatchByTmdbIds = vi.fn();
let insertCount = 0;
let mdblistConfigured = true;

vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: (...a: unknown[]) => debug(...a),
            info: vi.fn(),
            warn: (...a: unknown[]) => warn(...a),
            error: vi.fn(),
        }),
    },
}));

vi.mock('../services/mdblist-api.js', () => ({
    mdblistApi: {
        isAvailable: () => mdblistConfigured,
        getList: (...a: unknown[]) => getList(...a),
        getBatchByTmdbIds: (...a: unknown[]) => getBatchByTmdbIds(...a),
    },
}));

vi.mock('../utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('../database/queries/builders/provider-metadata.builder.js', () => ({
    buildProviderOrderUnsafe: vi.fn(),
    buildProviderFilterUnsafe: vi.fn(),
}));

vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return (strings: TemplateStringsArray) => {
                const text = strings.join('?');
                return Promise.resolve(
                    text.includes('INSERT INTO cached_list_items') ? { count: insertCount } : [],
                );
            };
        }
    },
}));

import { syncList, CURATED_LISTS } from './list-sync.js';

const list = CURATED_LISTS[0]!;

describe('syncList log levels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        insertCount = 0;
        mdblistConfigured = true;
        getList.mockResolvedValue([
            { id: 1, rank: 1, title: 'A', mediatype: 'movie' },
            { id: 2, rank: 2, title: 'B', mediatype: 'movie' },
        ]);
    });

    it('does not warn when no listed id is in the local catalog', async () => {
        const result = await syncList(list);

        expect(result).toMatchObject({ success: true, items_synced: 0 });
        expect(warn).not.toHaveBeenCalled();
        expect(debug.mock.calls.some((c) => String(c[0]).includes('resolved no items'))).toBe(true);
    });

    it('does not run the MDBList description batch fetch (result was never used)', async () => {
        await syncList(list);

        expect(getBatchByTmdbIds).not.toHaveBeenCalled();
    });

    it('still warns when the list itself returns nothing', async () => {
        getList.mockResolvedValue([]);

        const result = await syncList(list);

        expect(result.success).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('does not contact MDBList at all without an API key', async () => {
        mdblistConfigured = false;

        const result = await syncList(list);

        expect(result).toMatchObject({ success: false, items_synced: 0 });
        expect(getList).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });
});
