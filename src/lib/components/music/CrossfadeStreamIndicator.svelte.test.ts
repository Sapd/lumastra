// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { render, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CrossfadeStreamIndicator from './CrossfadeStreamIndicator.svelte';

type Fade = {
    role: 'incoming' | 'outgoing';
    otherTrack: { title: string; artistName?: string };
    remainingMs: number;
    durationMs: number;
};
const fade = (over: Partial<Fade> = {}): Fade => ({
    role: 'outgoing',
    otherTrack: { title: 'Next Song', artistName: 'Someone' },
    remainingMs: 4_000,
    durationMs: 8_000,
    ...over,
});
const barWidth = (container: HTMLElement): number =>
    parseFloat((container.querySelector('[aria-hidden="true"] > div') as HTMLElement).style.width);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('CrossfadeStreamIndicator', () => {
    it('names the other side by role', () => {
        const into = render(CrossfadeStreamIndicator, { crossfade: fade({ role: 'outgoing' }) });
        expect(into.container.textContent).toContain('Crossfading into');
        expect(into.container.textContent).toContain('Next Song — Someone');
        cleanup();
        const from = render(CrossfadeStreamIndicator, { crossfade: fade({ role: 'incoming' }) });
        expect(from.container.textContent).toContain('Crossfading from');
    });

    it('drains the bar locally and disappears when the fade runs out', () => {
        const { container } = render(CrossfadeStreamIndicator, { crossfade: fade() });
        expect(barWidth(container)).toBeCloseTo(50);
        vi.advanceTimersByTime(2_000);
        flushSync();
        expect(barWidth(container)).toBeCloseTo(25, 0);
        vi.advanceTimersByTime(2_200);
        flushSync();
        expect(container.querySelector('[data-testid="crossfade-indicator"]')).toBeNull();
    });

    it('re-anchors on a fresh value from the next poll', async () => {
        const view = render(CrossfadeStreamIndicator, { crossfade: fade() });
        vi.advanceTimersByTime(3_000);
        flushSync();
        await view.rerender({ crossfade: fade({ remainingMs: 4_000 }) });
        flushSync();
        expect(barWidth(view.container)).toBeCloseTo(50);
    });

    it('renders nothing for a fade that is already over', () => {
        const { container } = render(CrossfadeStreamIndicator, {
            crossfade: fade({ remainingMs: 0 }),
        });
        expect(container.querySelector('[data-testid="crossfade-indicator"]')).toBeNull();
    });
});
