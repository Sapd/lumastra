// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AdaptiveStreamBadge from './AdaptiveStreamBadge.svelte';
import type { SessionAdaptive } from '$lib/schemas/session-adaptive.js';

const adaptive: SessionAdaptive = {
    source: 'server',
    current: { id: '540p2m', height: 540, bitrate: 2_000_000 },
    currentSince: '2026-10-16T12:00:00.000Z',
    ladder: [
        { id: '1080p8m', height: 1080, bitrate: 8_000_000 },
        { id: '720p4m', height: 720, bitrate: 4_000_000 },
        { id: '540p2m', height: 540, bitrate: 2_000_000 },
        { id: '360p1m', height: 360, bitrate: 1_000_000 },
    ],
    tier: 'low',
    switches: 2,
    recentSwitches: [{ from: '720p4m', to: '540p2m', at: '2026-10-16T12:00:00.000Z' }],
    measuredBandwidth: 2_600_000,
    rebuffers: 1,
};

afterEach(() => cleanup());

describe('AdaptiveStreamBadge', () => {
    it('names the variant playing now and carries the ladder tier', () => {
        render(AdaptiveStreamBadge, { adaptive });
        const badge = screen.getByTestId('adaptive-badge');
        expect(badge.textContent).toContain('540p · 2 Mbps');
        expect(badge.dataset.tier).toBe('low');
        // The tooltip lists every rung with the playing one marked.
        expect(badge.getAttribute('title')).toContain('1080p · 8 Mbps');
        expect(badge.getAttribute('title')).toMatch(/▶ 540p · 2 Mbps/);
        expect(screen.queryByTestId('adaptive-details')).toBeNull();
    });

    it('detailed: ladder, switches, bandwidth and what the server encodes', () => {
        render(AdaptiveStreamBadge, {
            adaptive,
            detailed: true,
            encoder: {
                kind: 'adaptive',
                outputs: ['1080p8m', '720p4m', '540p2m'],
                viewers: 3,
                health: 'healthy',
                reservedOutputs: 3,
            },
            encoderHealthLabel: 'Healthy',
        });
        const details = screen.getByTestId('adaptive-details');
        expect(details.querySelector('[data-playing="true"]')?.getAttribute('data-variant')).toBe(
            '540p2m',
        );
        // A rung the group is not encoding right now is struck through.
        expect(details.querySelector('[data-variant="360p1m"]')?.className).toContain(
            'line-through',
        );
        expect(details.textContent).toContain('Switches: 2');
        expect(details.textContent).toContain('720p → 540p');
        expect(details.textContent).toContain('2.6 Mbps');
        expect(screen.getByTestId('adaptive-encoder').textContent).toContain(
            '1080p8m, 720p4m, 540p2m',
        );
    });

    it('falls back to the plain label before the variant is known', () => {
        render(AdaptiveStreamBadge, {
            adaptive: { source: 'client', ladder: adaptive.ladder },
        });
        expect(screen.getByTestId('adaptive-badge').textContent?.trim()).toBe('Adaptive');
        expect(screen.getByTestId('adaptive-badge').dataset.tier).toBe('unknown');
    });
});
