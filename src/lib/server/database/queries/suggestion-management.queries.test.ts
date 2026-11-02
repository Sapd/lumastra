// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the discovery-catalog gate in saveSuggestions: automatic
 * suggestion generation only mints stub media rows while
 * isDiscoveryCatalogEnabled() is true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const mocks = vi.hoisted(() => ({
    isDiscoveryCatalogEnabled: vi.fn(),
    batchResolveMediaIds: vi.fn(),
    resolveOrCreateMediaId: vi.fn(),
}));

vi.mock('../../config.js', () => ({ isDiscoveryCatalogEnabled: mocks.isDiscoveryCatalogEnabled }));
vi.mock('./resolvers/media-id.resolver.js', () => ({
    batchResolveMediaIds: mocks.batchResolveMediaIds,
}));
vi.mock('../../utils/media-resolution.js', () => ({
    resolveOrCreateMediaId: mocks.resolveOrCreateMediaId,
}));
vi.mock('./availability.queries.js', () => ({ isAvailableExpr: vi.fn(), canRequestExpr: vi.fn() }));
vi.mock('../../utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));

import { saveSuggestions, type UserSuggestionInput } from './suggestion-management.queries.js';

function makeSql() {
    const fn = vi.fn((..._args: unknown[]) => Promise.resolve([]));
    Object.assign(fn, { json: (v: unknown) => v });
    return fn as unknown as postgres.Sql & { mock: { calls: unknown[][] } };
}

const suggestion = {
    user_id: 'user-1',
    primary_ext_id: '555',
    media_type: 'movie',
    cache_context: 'general',
    combined_score: 0.5,
} as unknown as UserSuggestionInput;

function insertCount(sql: { mock: { calls: unknown[][] } }): number {
    return sql.mock.calls.filter((c) =>
        (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO user_suggestions'),
    ).length;
}

describe('saveSuggestions discovery gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.batchResolveMediaIds.mockResolvedValue(new Map());
        mocks.resolveOrCreateMediaId.mockResolvedValue('new-id');
    });

    it('creates a stub row for an unknown title when the discovery catalog is enabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(true);
        const sql = makeSql();

        await saveSuggestions(sql, [suggestion]);

        expect(mocks.resolveOrCreateMediaId).toHaveBeenCalledTimes(1);
        expect(insertCount(sql)).toBe(1);
    });

    it('drops a suggestion without a catalog row (no stub) when disabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        const sql = makeSql();

        await saveSuggestions(sql, [suggestion]);

        expect(mocks.resolveOrCreateMediaId).not.toHaveBeenCalled();
        expect(insertCount(sql)).toBe(0);
    });

    it('still saves a suggestion for an existing row when disabled', async () => {
        mocks.isDiscoveryCatalogEnabled.mockReturnValue(false);
        mocks.batchResolveMediaIds.mockResolvedValue(new Map([['555:movie', 'existing-id']]));
        const sql = makeSql();

        await saveSuggestions(sql, [suggestion]);

        expect(mocks.resolveOrCreateMediaId).not.toHaveBeenCalled();
        expect(insertCount(sql)).toBe(1);
    });
});
