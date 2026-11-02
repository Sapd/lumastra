// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import ChannelPicker from './ChannelPicker.svelte';
import type { GroupedProgramChannel } from '$lib/schemas/livetv.js';

const mockChannels: GroupedProgramChannel[] = [
    {
        id: 'ch-1',
        name: 'LRV',
        images: { primary: { href: 'https://example.com/lrv.png', revision: '1', source: 'self' } },
    },
    {
        id: 'ch-2',
        name: 'KWF',
        images: { primary: { href: 'https://example.com/kwf.png', revision: '1', source: 'self' } },
    },
    { id: 'ch-3', name: 'MTK', images: {} },
];

describe('ChannelPicker', () => {
    test('renders all channels with names', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        expect(screen.getByText('LRV')).toBeTruthy();
        expect(screen.getByText('KWF')).toBeTruthy();
        expect(screen.getByText('MTK')).toBeTruthy();
    });

    test('renders logos for channels that have logoUrl', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const images = screen.getAllByRole('img');
        expect(images).toHaveLength(2);
        expect(images[0].getAttribute('alt')).toBe('LRV');
        expect(images[1].getAttribute('alt')).toBe('KWF');
    });

    test('renders text fallback when logoUrl is undefined', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        // MTK has no logo, should show 'M' as fallback
        expect(screen.getByText('M')).toBeTruthy();
    });

    test('first channel has primary emphasis styling', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const buttons = screen.getAllByRole('option');
        expect(buttons[0].className).toContain('bg-surface-600/80');
        expect(buttons[1].className).toContain('bg-surface-700/50');
        expect(buttons[2].className).toContain('bg-surface-700/50');
    });

    test('clicking a channel calls onSelect with correct channelId', async () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const buttons = screen.getAllByRole('option');
        await fireEvent.click(buttons[1]);

        expect(onSelect).toHaveBeenCalledOnce();
        expect(onSelect).toHaveBeenCalledWith('ch-2');
    });

    test('keyboard ArrowDown moves focus to next channel', async () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const buttons = screen.getAllByRole('option');
        buttons[0].focus();

        await fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });

        expect(document.activeElement).toBe(buttons[1]);
    });

    test('keyboard ArrowUp moves focus to previous channel', async () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const buttons = screen.getAllByRole('option');
        buttons[1].focus();

        await fireEvent.keyDown(buttons[1], { key: 'ArrowUp' });

        expect(document.activeElement).toBe(buttons[0]);
    });

    test('has labeled listbox role on container', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const listbox = screen.getByRole('listbox');
        expect(listbox).toBeTruthy();
        expect(listbox.getAttribute('aria-label')).toBeTruthy();
    });

    test('all options have aria-selected=false (navigation picker, not selection)', () => {
        const onSelect = vi.fn();
        render(ChannelPicker, { channels: mockChannels, onSelect });

        const buttons = screen.getAllByRole('option');
        for (const button of buttons) {
            expect(button.getAttribute('aria-selected')).toBe('false');
        }
    });
});
