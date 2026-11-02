// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Episode-title reconciliation has two tiers: the preview lists matches from
 * RECONCILE_PREVIEW_CONFIDENCE, the bulk "Apply high-confidence" button
 * applies only those from RECONCILE_AUTO_APPLY_CONFIDENCE. The button must say
 * how many it will apply, and do nothing when that is none.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    getSeriesHealth: vi.fn(),
    getReconciliationPreview: vi.fn(),
    applyReconciliation: vi.fn(),
}));
vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import HealthTab from './HealthTab.svelte';

function proposal(id: string, confidence: number): unknown {
    return {
        episodeId: id,
        fileId: `f-${id}`,
        seasonNumber: 1,
        episodeNumber: 1,
        currentTitle: 'Episode 1',
        proposedTitle: `Real title ${id}`,
        matchedTmdbEpisodeId: '1',
        confidence,
        changed: true,
        reason: 'matched',
        source: 'chapters',
    };
}

async function preview(proposals: unknown[]): Promise<HTMLButtonElement> {
    api.getSeriesHealth.mockResolvedValue({ data: { report: null }, error: undefined });
    api.getReconciliationPreview.mockResolvedValue({
        data: { proposals, changedCount: proposals.length, needsReviewCount: 0 },
        error: undefined,
    });
    render(HealthTab, { props: { seriesId: 'series-1' } });
    await fireEvent.click(await screen.findByRole('button', { name: /Analyze episode titles/i }));
    return (await screen.findByRole('button', {
        name: /Apply high-confidence/,
    })) as HTMLButtonElement;
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('HealthTab reconcile tiers', () => {
    it('counts only the matches the bulk button will apply', async () => {
        const button = await preview([proposal('a', 0.85), proposal('b', 0.92)]);
        expect(button.textContent).toContain(': 1');
        expect(button.disabled).toBe(false);
    });

    it('disables the bulk button when no match reaches the auto-apply tier', async () => {
        const button = await preview([proposal('a', 0.85)]);
        expect(button.textContent).toContain(': 0');
        expect(button.disabled).toBe(true);
    });
});

it('names episode coverage rather than claiming overall file health', async () => {
    api.getSeriesHealth.mockResolvedValue({
        data: {
            report: {
                orderingHealth: {
                    orderingType: 'standard',
                    total: 2,
                    linked: 2,
                    unlinked: 0,
                    linkRatio: 1,
                },
            },
        },
    });
    render(HealthTab, { seriesId: 'series-1' });
    expect(await screen.findByText('All ordered episodes linked')).toBeTruthy();
    expect(screen.queryByText('Healthy')).toBeNull();
    expect(screen.getByText('Open Episodes to see which entries still need links.')).toBeTruthy();
    const help = screen.getByText('What is this page?').closest('details');
    expect(help?.open).toBe(false);
});

it.each([
    [1, 2],
    [95, 100],
])('does not claim all episodes are linked when %i of %i have links', async (linked, total) => {
    api.getSeriesHealth.mockResolvedValue({
        data: {
            report: {
                orderingHealth: {
                    orderingType: 'standard',
                    total,
                    linked,
                    unlinked: total - linked,
                    linkRatio: linked / total,
                },
            },
        },
    });
    render(HealthTab, { seriesId: 'series-1' });
    expect(await screen.findByText('Some episodes are not linked')).toBeTruthy();
    expect(screen.queryByText('All ordered episodes linked')).toBeNull();
});
