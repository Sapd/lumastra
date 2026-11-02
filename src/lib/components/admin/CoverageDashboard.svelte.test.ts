// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import { Sparkles } from 'svelte-hero-icons';

// AdminPageHeader (rendered by CoverageDashboard) reads $page and can pin nav
// items. Stub the SvelteKit runtime deps so the header renders in happy-dom.
vi.mock('$app/stores', () => ({
    page: readable({
        url: new URL('http://localhost/admin/developer/vod-embeddings'),
        data: { navPins: [] },
    }),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
    addNavPin: vi.fn(async () => ({ error: null })),
    removeNavPin: vi.fn(async () => ({ error: null })),
}));

import CoverageDashboard from './CoverageDashboard.svelte';

const baseProps = {
    title: 'VOD Embeddings',
    description: 'AI embeddings for movies and TV',
    icon: Sparkles,
};

describe('CoverageDashboard', () => {
    test('renders the title and description', () => {
        render(CoverageDashboard, { props: { ...baseProps } });
        expect(screen.getByText('VOD Embeddings')).toBeTruthy();
        expect(screen.getByText('AI embeddings for movies and TV')).toBeTruthy();
    });

    test('renders stat cards with their values', () => {
        render(CoverageDashboard, {
            props: {
                ...baseProps,
                stats: [
                    { title: 'Eligible', value: '1,234', subtitle: 'Catalog items' },
                    { title: 'Completed', value: '1,000', color: 'green' },
                ],
            },
        });
        expect(screen.getByText('Eligible')).toBeTruthy();
        expect(screen.getByText('1,234')).toBeTruthy();
        expect(screen.getByText('Completed')).toBeTruthy();
        expect(screen.getByText('1,000')).toBeTruthy();
    });

    test('renders a coverage bar with the percent and color threshold', () => {
        render(CoverageDashboard, {
            props: {
                ...baseProps,
                coverageBars: [
                    {
                        label: 'Coverage',
                        description: '1,000 of 1,234 items have embeddings',
                        percent: 81,
                    },
                ],
            },
        });
        expect(screen.getByText('Coverage')).toBeTruthy();
        expect(screen.getByText('1,000 of 1,234 items have embeddings')).toBeTruthy();
        const pct = screen.getByText('81%');
        expect(pct).toBeTruthy();
        // >= 80 → healthy green
        expect(pct.className).toContain('text-green-400');
        // bar fill width reflects the percent
        const fill = document.querySelector('[data-coverage-fill]') as HTMLElement;
        expect(fill).toBeTruthy();
        expect(fill.style.width).toBe('81%');
    });

    test('renders action buttons and invokes their handler on click', async () => {
        const onclick = vi.fn();
        render(CoverageDashboard, {
            props: {
                ...baseProps,
                actions: [
                    {
                        id: 'start-backfill',
                        label: 'Start Backfill',
                        description: 'Generate embeddings for all eligible items',
                        onclick,
                    },
                ],
            },
        });
        const btn = screen.getByRole('button', { name: /Start Backfill/i });
        await fireEvent.click(btn);
        expect(onclick).toHaveBeenCalledOnce();
    });

    test('renders the "how it works" info items', () => {
        render(CoverageDashboard, {
            props: {
                ...baseProps,
                infoItems: ['Eligible: active movies and TV', 'Model: text-embedding-3-small'],
            },
        });
        // Each item renders with a "• " bullet prefix, so match on substring.
        expect(screen.getByText(/Eligible: active movies and TV/)).toBeTruthy();
        expect(screen.getByText(/Model: text-embedding-3-small/)).toBeTruthy();
    });

    test('shows a loading state when loading and no stats yet', () => {
        render(CoverageDashboard, { props: { ...baseProps, loading: true } });
        expect(screen.getByText(/Loading/i)).toBeTruthy();
    });
});
