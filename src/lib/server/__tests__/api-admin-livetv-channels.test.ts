// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for admin LiveTV channels API endpoint:
 * - Transform/grouping logic (unit)
 * - Response schema validation (contract)
 */

import { describe, it, expect } from 'vitest';
import type { AdminChannelRow } from '$lib/server/database/queries/livetv-channels.queries.js';
import { groupChannelsByCategory } from '$lib/server/utils/livetv-admin-transforms.js';
import { AdminChannelsResponseSchema } from '$lib/schemas/livetv.js';

function makeRow(overrides: Partial<AdminChannelRow> = {}): AdminChannelRow {
    return {
        id: 'uuid-ch-1',
        name: 'Test Channel',
        stream_url: 'https://example.com/test.m3u8',
        logo_url: null,
        quality_tier: 'hd',
        epg_channel_id: null,
        sort_order: 0,
        is_visible: true,
        category_id: null,
        category_name: null,
        category_sort_order: null,
        category_is_visible: null,
        backup_group_id: null,
        group_primary_channel_id: null,
        epg_match_confidence: null,
        epg_match_signals: null,
        source_id: 'uuid-source-1',
        country_code: null,
        consecutive_absences: 0,
        created_at: new Date('2026-01-01'),
        admin_display_name: null,
        category_number_start: null,
        channel_number: null,
        channel_number_pinned: null,
        ...overrides,
    };
}

describe('groupChannelsByCategory', () => {
    it('returns empty categories for empty rows', () => {
        const result = groupChannelsByCategory([]);

        expect(result).toEqual({
            categories: [],
            totalChannels: 0,
            visibleChannels: 0,
        });
    });

    it('groups channels by category', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                name: 'WBN One',
                category_id: 'cat-1',
                category_name: 'Entertainment',
                category_sort_order: 1,
                category_is_visible: true,
            }),
            makeRow({
                id: 'ch-2',
                name: 'Orb Sport',
                category_id: 'cat-2',
                category_name: 'Sport',
                category_sort_order: 2,
                category_is_visible: true,
            }),
            makeRow({
                id: 'ch-3',
                name: 'JTV',
                category_id: 'cat-1',
                category_name: 'Entertainment',
                category_sort_order: 1,
                category_is_visible: true,
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories).toHaveLength(2);
        expect(result.categories[0].name).toBe('Entertainment');
        expect(result.categories[0].channels).toHaveLength(2);
        expect(result.categories[1].name).toBe('Sport');
        expect(result.categories[1].channels).toHaveLength(1);
    });

    it('puts uncategorized channels into virtual Uncategorized group', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                name: 'No Category',
                category_id: null,
                category_name: null,
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories).toHaveLength(1);
        expect(result.categories[0].id).toBe('uncategorized');
        expect(result.categories[0].name).toBe('Uncategorized');
    });

    it('sorts Uncategorized group last', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                name: 'Uncategorized Channel',
                category_id: null,
                category_name: null,
                category_sort_order: null,
            }),
            makeRow({
                id: 'ch-2',
                name: 'Categorized Channel',
                category_id: 'cat-1',
                category_name: 'Sports',
                category_sort_order: 1,
                category_is_visible: true,
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories).toHaveLength(2);
        expect(result.categories[0].name).toBe('Sports');
        expect(result.categories[1].name).toBe('Uncategorized');
    });

    it('counts total and visible channels correctly', () => {
        const rows = [
            makeRow({ id: 'ch-1', is_visible: true }),
            makeRow({ id: 'ch-2', is_visible: true }),
            makeRow({ id: 'ch-3', is_visible: false }),
            makeRow({ id: 'ch-4', is_visible: false }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.totalChannels).toBe(4);
        expect(result.visibleChannels).toBe(2);
    });

    it('maps admin_display_name to adminDisplayName', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                name: 'Display Name',
                admin_display_name: 'Custom Admin Name',
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories[0].channels[0].adminDisplayName).toBe('Custom Admin Name');
    });

    it('maps null admin_display_name to undefined', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                admin_display_name: null,
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories[0].channels[0].adminDisplayName).toBeUndefined();
    });

    it('maps epg_channel_id to epgChannelId', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                epg_channel_id: 'wbn1.de',
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories[0].channels[0].epgChannelId).toBe('wbn1.de');
    });

    it('preserves category sort order', () => {
        const rows = [
            makeRow({
                id: 'ch-3',
                category_id: 'cat-3',
                category_name: 'Third',
                category_sort_order: 30,
                category_is_visible: true,
            }),
            makeRow({
                id: 'ch-1',
                category_id: 'cat-1',
                category_name: 'First',
                category_sort_order: 10,
                category_is_visible: true,
            }),
            makeRow({
                id: 'ch-2',
                category_id: 'cat-2',
                category_name: 'Second',
                category_sort_order: 20,
                category_is_visible: true,
            }),
        ];

        const result = groupChannelsByCategory(rows);

        expect(result.categories.map((c) => c.name)).toEqual(['First', 'Second', 'Third']);
    });

    it('converts null fields to undefined in channel output', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                logo_url: null,
                backup_group_id: null,
                source_id: null,
                epg_channel_id: null,
            }),
        ];

        const result = groupChannelsByCategory(rows);
        const ch = result.categories[0].channels[0];

        expect(ch.images).toEqual({});
        expect(ch.backupGroupId).toBeUndefined();
        expect(ch.sourceId).toBeUndefined();
        expect(ch.epgChannelId).toBeUndefined();
    });
});

// =============================================================================
// Schema validation — ensures transform output conforms to API response contract
// =============================================================================

describe('AdminChannelsResponseSchema validation', () => {
    it('validates grouped output with populated categories', () => {
        const rows = [
            makeRow({
                id: 'ch-1',
                name: 'WBN One',
                quality_tier: 'fhd',
                epg_channel_id: 'wbn1.de',
                is_visible: true,
                category_id: 'cat-1',
                category_name: 'Entertainment',
                category_sort_order: 1,
                category_is_visible: true,
                backup_group_id: 'bg-1',
                admin_display_name: 'WBN 1',
            }),
            makeRow({
                id: 'ch-2',
                name: 'Hidden Channel',
                quality_tier: null,
                is_visible: false,
                category_id: null,
                category_name: null,
            }),
        ];

        const result = groupChannelsByCategory(rows);
        const parsed = AdminChannelsResponseSchema.safeParse(result);

        expect(parsed.success).toBe(true);
    });

    it('validates empty state response', () => {
        const result = groupChannelsByCategory([]);
        const parsed = AdminChannelsResponseSchema.safeParse(result);

        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.categories).toEqual([]);
            expect(parsed.data.totalChannels).toBe(0);
            expect(parsed.data.visibleChannels).toBe(0);
        }
    });

    it('validates all quality tier values pass schema', () => {
        const tiers = ['uhd', 'fhd', 'hd', 'sd'] as const;
        for (const tier of tiers) {
            const rows = [makeRow({ id: `ch-${tier}`, quality_tier: tier })];
            const result = groupChannelsByCategory(rows);
            const parsed = AdminChannelsResponseSchema.safeParse(result);

            expect(parsed.success, `quality tier '${tier}' should be valid`).toBe(true);
        }
    });

    it('rejects invalid quality tier in schema', () => {
        const result = groupChannelsByCategory([]);
        const invalid = {
            ...result,
            categories: [
                {
                    id: 'cat-1',
                    name: 'Test',
                    sortOrder: 0,
                    isVisible: true,
                    channels: [
                        {
                            id: 'ch-1',
                            name: 'Bad Channel',
                            images: {},
                            sortOrder: 0,
                            isVisible: true,
                            qualityTier: 'invalid-tier',
                        },
                    ],
                },
            ],
        };
        const parsed = AdminChannelsResponseSchema.safeParse(invalid);

        expect(parsed.success).toBe(false);
    });
});
