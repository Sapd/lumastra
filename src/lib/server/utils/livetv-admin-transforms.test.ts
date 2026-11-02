// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { groupChannelsByCategory } from './livetv-admin-transforms.js';
import type { AdminChannelRow } from '$lib/server/database/queries/livetv-channels.queries.js';

function row(overrides: Partial<AdminChannelRow> & { id: string }): AdminChannelRow {
    return {
        name: overrides.id,
        stream_url: 'http://example/1.ts',
        logo_url: null,
        quality_tier: null,
        epg_channel_id: null,
        sort_order: 0,
        is_visible: true,
        category_id: 'cat-1',
        category_name: 'Free TV',
        category_sort_order: 0,
        category_is_visible: true,
        backup_group_id: null,
        group_primary_channel_id: null,
        source_id: null,
        country_code: null,
        consecutive_absences: 0,
        created_at: new Date(),
        admin_display_name: null,
        epg_match_confidence: null,
        epg_match_signals: null,
        ...overrides,
    } as AdminChannelRow;
}

describe('groupChannelsByCategory', () => {
    it('maps the backup-group primary through to the client', () => {
        const result = groupChannelsByCategory([
            row({ id: 'rtl-fhd', backup_group_id: 'g', group_primary_channel_id: 'rtl-uhd' }),
        ]);

        const channel = result.categories[0].channels[0];
        expect(channel.backupGroupId).toBe('g');
        expect(channel.groupPrimaryChannelId).toBe('rtl-uhd');
    });

    // NULL means either "ungrouped" or "group lost its primary" — both must come
    // across as absent rather than null, per the schema's .optional() contract.
    it('omits the primary id when the column is NULL', () => {
        const result = groupChannelsByCategory([
            row({ id: 'solo', backup_group_id: null, group_primary_channel_id: null }),
        ]);

        expect(result.categories[0].channels[0].groupPrimaryChannelId).toBeUndefined();
    });

    it('omits the primary id for a group whose primary was deleted', () => {
        const result = groupChannelsByCategory([
            row({ id: 'orphan', backup_group_id: 'g', group_primary_channel_id: null }),
        ]);

        const channel = result.categories[0].channels[0];
        expect(channel.backupGroupId).toBe('g');
        expect(channel.groupPrimaryChannelId).toBeUndefined();
    });

    it('counts visible and total channels', () => {
        const result = groupChannelsByCategory([
            row({ id: 'a' }),
            row({ id: 'b', is_visible: false }),
        ]);

        expect(result.totalChannels).toBe(2);
        expect(result.visibleChannels).toBe(1);
    });

    it('passes a name match (no EPG channel id) through as confidence and signals', () => {
        const result = groupChannelsByCategory([
            row({
                id: 'premieren',
                epg_match_confidence: 0.9,
                epg_match_signals: ['name_exact'],
            }),
            row({ id: 'plain' }),
        ]);
        const [matched, plain] = result.categories[0].channels;
        expect(matched.epgChannelId).toBeUndefined();
        expect(matched.epgMatchConfidence).toBe(0.9);
        expect(matched.epgMatchSignals).toEqual(['name_exact']);
        expect(plain.epgMatchConfidence).toBeUndefined();
        expect(plain.epgMatchSignals).toBeUndefined();
    });

    it('builds logo URLs that 404 when the logo cannot be fetched', () => {
        const result = groupChannelsByCategory([
            row({ id: 'with-logo', logo_url: 'http://provider.invalid/logo.png' }),
            row({ id: 'no-logo' }),
        ]);
        const [withLogo, noLogo] = result.categories[0].channels;
        expect(withLogo.images.primary?.href).toContain('fallback=none');
        expect(noLogo.images).toEqual({});
    });
});
