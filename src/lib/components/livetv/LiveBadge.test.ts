// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import LiveBadge from './LiveBadge.svelte';

vi.mock('$lib/paraglide/messages.js', () => ({
    temporal_live: () => 'LIVE',
    temporal_live_aria: () => 'Live now',
}));

describe('LiveBadge', () => {
    test('renders "LIVE" text', () => {
        render(LiveBadge);
        expect(screen.getByText('LIVE')).toBeTruthy();
    });

    test('has accessible aria-label', () => {
        render(LiveBadge);
        expect(screen.getByLabelText('Live now')).toBeTruthy();
    });

    test('uses sm size classes by default', () => {
        render(LiveBadge);
        const badge = screen.getByText('LIVE');
        expect(badge.className).toContain('text-[10px]');
    });

    test('uses md size classes when specified', () => {
        render(LiveBadge, { size: 'md' });
        const badge = screen.getByText('LIVE');
        expect(badge.className).toContain('text-xs');
    });

    test('has green background for visibility', () => {
        render(LiveBadge);
        const badge = screen.getByText('LIVE');
        expect(badge.className).toContain('bg-green-500');
    });
});
