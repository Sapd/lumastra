// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildBoundItemIds,
    isBoundToItem,
    normalizeItemId,
    truncateForLog,
} from './job-item-binding.js';

describe('normalizeItemId', () => {
    it('lowercases and adds dashes to a dashless UUID', () => {
        expect(normalizeItemId('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        );
    });

    it('lowercases a dashed UUID', () => {
        expect(normalizeItemId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')).toBe(
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        );
    });

    it('leaves a non-UUID id unchanged', () => {
        expect(normalizeItemId('item-not-a-uuid')).toBe('item-not-a-uuid');
    });
});

describe('buildBoundItemIds', () => {
    it('returns null (fail closed) when internalId is missing', () => {
        expect(buildBoundItemIds(undefined, 'raw-item')).toBeNull();
    });

    it('returns null (fail closed) when internalId is empty', () => {
        expect(buildBoundItemIds('', 'raw-item')).toBeNull();
    });

    it('admits both the internal and raw spellings, normalized', () => {
        const dashed = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const dashless = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const bound = buildBoundItemIds(dashed, dashless);
        expect(bound).not.toBeNull();
        expect(bound?.has(dashed)).toBe(true);
        // the dashless raw id normalizes to the same dashed spelling
        expect(bound?.size).toBe(1);
    });
});

describe('isBoundToItem', () => {
    it('is false when bound is null (fail closed)', () => {
        expect(isBoundToItem('item-x', null)).toBe(false);
    });

    it('is false when the candidate is missing', () => {
        const bound = buildBoundItemIds('item-x', 'item-x');
        expect(isBoundToItem(undefined, bound)).toBe(false);
        expect(isBoundToItem(null, bound)).toBe(false);
    });

    it('is true for a member of the bound set', () => {
        const bound = buildBoundItemIds('item-x', 'item-x');
        expect(isBoundToItem('item-x', bound)).toBe(true);
    });

    it('is false for a foreign item', () => {
        const bound = buildBoundItemIds('item-x', 'item-x');
        expect(isBoundToItem('item-y', bound)).toBe(false);
    });

    it('admits a dashed/dashless respelling of the same UUID', () => {
        const dashed = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const dashless = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const bound = buildBoundItemIds(dashed, dashed);
        expect(isBoundToItem(dashless, bound)).toBe(true);
    });
});

describe('truncateForLog', () => {
    it('truncates to 8 characters', () => {
        expect(truncateForLog('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe('aaaaaaaa');
    });

    it('handles missing values', () => {
        expect(truncateForLog(undefined)).toBe('');
        expect(truncateForLog(null)).toBe('');
    });
});
