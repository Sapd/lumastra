// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { AdminChannel } from '$lib/schemas/livetv.js';
import ChannelRow from './ChannelRow.svelte';

vi.mock('$lib/paraglide/messages.js', () => ({
    admin_livetv_reorder_handle_tooltip: () => 'Drag to reorder',
    admin_livetv_bulk_hide: () => 'Hide',
    admin_livetv_bulk_show: () => 'Show',
    admin_livetv_epg_matched: () => 'Matched',
    admin_livetv_epg_unmatched: () => 'Unmatched',
    admin_livetv_epg_shared: () => 'Matched (shared)',
    admin_livetv_epg_confidence_medium: () => 'Low confidence',
    admin_livetv_epg_confidence_percent: ({ percent }: { percent: number }) =>
        `Match confidence ${percent}%`,
    admin_livetv_quality_uhd: () => 'UHD',
    admin_livetv_quality_fhd: () => 'FHD',
    admin_livetv_quality_hd: () => 'HD',
    admin_livetv_quality_sd: () => 'SD',
    admin_livetv_edit_name: () => 'Edit channel name',
    admin_livetv_edit_name_placeholder: () => 'Enter channel name',
    admin_livetv_name_save_error: () => 'Failed to update channel name',
    admin_livetv_quality_save_error: () => 'Failed to update quality tier',
    admin_livetv_in_backup_group: () => 'In a backup group',
    admin_livetv_not_shown_superseded: ({ primaryName }: { primaryName: string }) =>
        `Not shown to viewers — superseded by “${primaryName}”`,
    admin_livetv_not_shown_superseded_unnamed: () =>
        'Not shown to viewers — superseded by another channel in its backup group',
    admin_livetv_not_shown_category_hidden: () => 'Not shown to viewers — category is hidden',
}));

function makeChannel(overrides: Partial<AdminChannel> = {}): AdminChannel {
    return {
        id: 'ch-1',
        name: 'Test Channel',
        images: {},
        sortOrder: 0,
        isVisible: true,
        qualityTier: 'hd',
        ...overrides,
    } as AdminChannel;
}

// =============================================================================
// Inline Name Editing (Task 6.1)
// =============================================================================

describe('Inline name editing', () => {
    test('clicking name enters edit mode (input appears)', async () => {
        const user = userEvent.setup();
        const channel = makeChannel();

        render(ChannelRow, { channel, mode: 'table' });

        const nameDiv = screen.getByText('Test Channel');
        await user.click(nameDiv);

        const input = screen.getByRole('textbox', {
            name: 'Edit channel name',
        });
        expect(input).toBeTruthy();
        expect((input as HTMLInputElement).value).toBe('Test Channel');
    });

    test('blur triggers save callback with new value', async () => {
        const user = userEvent.setup();
        const onNameUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel();

        render(ChannelRow, { channel, mode: 'table', onNameUpdate });

        // Enter edit mode
        const nameDiv = screen.getByText('Test Channel');
        await user.click(nameDiv);

        const input = screen.getByRole('textbox', {
            name: 'Edit channel name',
        });
        await user.clear(input);
        await user.type(input, 'Renamed Channel');
        await user.tab(); // blur

        expect(onNameUpdate).toHaveBeenCalledWith('ch-1', 'Renamed Channel');
    });

    test('Escape cancels edit without saving', async () => {
        const user = userEvent.setup();
        const onNameUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel();

        render(ChannelRow, { channel, mode: 'table', onNameUpdate });

        const nameDiv = screen.getByText('Test Channel');
        await user.click(nameDiv);

        const input = screen.getByRole('textbox', {
            name: 'Edit channel name',
        });
        await user.clear(input);
        await user.type(input, 'Something Else');
        await user.keyboard('{Escape}');

        expect(onNameUpdate).not.toHaveBeenCalled();
        // Should exit edit mode and show original name
        expect(screen.getByText('Test Channel')).toBeTruthy();
    });

    test('empty name reverts to original', async () => {
        const user = userEvent.setup();
        const onNameUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel();

        render(ChannelRow, { channel, mode: 'table', onNameUpdate });

        const nameDiv = screen.getByText('Test Channel');
        await user.click(nameDiv);

        const input = screen.getByRole('textbox', {
            name: 'Edit channel name',
        });
        await user.clear(input);
        await user.tab(); // blur with empty value

        expect(onNameUpdate).not.toHaveBeenCalled();
    });

    test('edit mode disabled during selection mode', async () => {
        const user = userEvent.setup();
        const onNameUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel();

        render(ChannelRow, {
            channel,
            mode: 'table',
            isSelectionMode: true,
            onNameUpdate,
        });

        const nameDiv = screen.getByText('Test Channel');
        await user.click(nameDiv);

        // Should NOT enter edit mode — no input should appear
        expect(screen.queryByRole('textbox', { name: 'Edit channel name' })).toBeNull();
    });

    test('shows adminDisplayName when set', () => {
        const channel = makeChannel({ adminDisplayName: 'Custom Name' });

        render(ChannelRow, { channel, mode: 'table' });

        expect(screen.getByText('Custom Name')).toBeTruthy();
    });
});

// =============================================================================
// Quality Tier Toggle (Task 6.2)
// =============================================================================

describe('Quality tier toggle', () => {
    test('clicking quality badge opens picker', async () => {
        const user = userEvent.setup();
        const channel = makeChannel({ qualityTier: 'hd' });

        render(ChannelRow, { channel, mode: 'table' });

        const badge = screen.getByText('HD');
        await user.click(badge);

        // All quality tiers should be visible in the picker
        expect(screen.getByText('UHD')).toBeTruthy();
        expect(screen.getByText('FHD')).toBeTruthy();
        // HD already visible as badge, check picker has it too
        expect(screen.getAllByText('HD').length).toBeGreaterThanOrEqual(2);
        expect(screen.getByText('SD')).toBeTruthy();
    });

    test('selecting a tier calls update callback', async () => {
        const user = userEvent.setup();
        const onQualityUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel({ qualityTier: 'hd' });

        render(ChannelRow, { channel, mode: 'table', onQualityUpdate });

        const badge = screen.getByText('HD');
        await user.click(badge);

        // Select FHD
        const fhdOption = screen.getAllByText('FHD');
        // Click the one that's a button inside the picker
        const fhdButton = fhdOption.find((el) => el.closest('button'));
        expect(fhdButton).toBeTruthy();
        await user.click(fhdButton!);

        expect(onQualityUpdate).toHaveBeenCalledWith('ch-1', 'fhd');
    });

    test('selecting same tier does not call update', async () => {
        const user = userEvent.setup();
        const onQualityUpdate = vi.fn().mockResolvedValue(undefined);
        const channel = makeChannel({ qualityTier: 'hd' });

        render(ChannelRow, { channel, mode: 'table', onQualityUpdate });

        const badge = screen.getByText('HD');
        await user.click(badge);

        // Click the HD option in picker
        const hdButtons = screen.getAllByText('HD');
        const hdPickerButton = hdButtons.find((el) =>
            el.closest('button[class*="hover:bg-surface-700"]'),
        );
        expect(hdPickerButton).toBeTruthy();
        await user.click(hdPickerButton!);

        expect(onQualityUpdate).not.toHaveBeenCalled();
    });

    test('clicking outside closes picker', async () => {
        const user = userEvent.setup();
        const channel = makeChannel({ qualityTier: 'hd' });

        render(ChannelRow, { channel, mode: 'table' });

        const badge = screen.getByText('HD');
        await user.click(badge);

        // Picker should be open
        expect(screen.getByText('UHD')).toBeTruthy();

        // Click outside the picker
        await user.click(document.body);

        // Picker should be closed — UHD should no longer be in the DOM
        expect(screen.queryByText('UHD')).toBeNull();
    });

    test('quality picker disabled during selection mode', async () => {
        const user = userEvent.setup();
        const channel = makeChannel({ qualityTier: 'hd' });

        render(ChannelRow, {
            channel,
            mode: 'table',
            isSelectionMode: true,
        });

        const badge = screen.getByText('HD');
        await user.click(badge);

        // Picker should NOT open
        expect(screen.queryByText('UHD')).toBeNull();
    });
});

// =============================================================================
// Viewer-visibility warning badge
// =============================================================================

describe('Viewer warning badge', () => {
    test('renders nothing when the channel is shown to viewers', () => {
        render(ChannelRow, {
            props: { channel: makeChannel(), mode: 'table', viewerStatus: { kind: 'shown' } },
        });
        expect(screen.queryByTestId('viewer-warning')).toBeNull();
    });

    test('renders nothing when no status is supplied', () => {
        render(ChannelRow, { props: { channel: makeChannel(), mode: 'table' } });
        expect(screen.queryByTestId('viewer-warning')).toBeNull();
    });

    test('names the superseding primary', () => {
        render(ChannelRow, {
            props: {
                channel: makeChannel({ name: 'MTK FHD' }),
                mode: 'table',
                viewerStatus: { kind: 'superseded', shownName: 'MTK UHD ¹' },
            },
        });
        expect(screen.getByTestId('viewer-warning').textContent).toContain('MTK UHD ¹');
    });

    test('warns without a name when the primary is outside the payload', () => {
        render(ChannelRow, {
            props: {
                channel: makeChannel(),
                mode: 'table',
                viewerStatus: { kind: 'superseded' },
            },
        });
        expect(screen.getByTestId('viewer-warning').textContent).toContain('another channel');
    });

    test('renders the badge in card mode too', () => {
        render(ChannelRow, {
            props: {
                channel: makeChannel(),
                mode: 'card',
                viewerStatus: { kind: 'category-hidden' },
            },
        });
        expect(screen.getByTestId('viewer-warning').textContent).toContain('category is hidden');
    });
});

// =============================================================================
// EPG column: a name match (bare playlist) has no EPG channel id
// =============================================================================

describe('EPG status', () => {
    test('a name match without an EPG channel id shows as matched, with its confidence', () => {
        const channel = makeChannel({ epgMatchConfidence: 0.9, epgMatchSignals: ['name_exact'] });
        render(ChannelRow, { channel, mode: 'table' });
        const cell = screen.getByText('Matched');
        expect(cell.closest('[title]')?.getAttribute('title')).toBe('Match confidence 90%');
        expect(screen.queryByText('Unmatched')).toBeNull();
    });

    test('a guide shared from a sibling feed says so', () => {
        const channel = makeChannel({
            epgMatchConfidence: 0.855,
            epgMatchSignals: ['name_exact', 'backup_propagation'],
        });
        render(ChannelRow, { channel, mode: 'card' });
        expect(screen.getByText('Matched (shared)')).toBeTruthy();
    });

    test('no match at all stays unmatched', () => {
        render(ChannelRow, { channel: makeChannel(), mode: 'table' });
        expect(screen.getByText('Unmatched')).toBeTruthy();
    });
});
