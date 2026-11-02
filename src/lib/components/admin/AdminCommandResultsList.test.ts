// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import AdminCommandResultsList from './AdminCommandResultsList.svelte';
import type { PaletteResults } from '$lib/utils/admin/command-palette';
import type { FlatPaletteItem } from '$lib/utils/admin/use-command-palette.svelte';
import type { RecentEntry } from '$lib/utils/admin/command-palette-recents';

const RESULTS: PaletteResults = {
    pages: [
        {
            kind: 'page',
            path: '/admin/system/health',
            href: '/admin/system/health',
            title: 'System Health',
            sectionId: 'system',
            sectionTitle: 'System',
        },
        {
            kind: 'tab',
            path: '/admin/system/health',
            href: '/admin/system/health?tab=cluster',
            title: 'Cluster',
            parentTitle: 'System Health',
            sectionId: 'system',
            sectionTitle: 'System',
        },
    ],
    settings: [],
    providers: [],
};
const FLAT: FlatPaletteItem[] = [
    { kind: 'page', href: '/admin/system/health', dest: RESULTS.pages[0] },
    { kind: 'page', href: '/admin/system/health?tab=cluster', dest: RESULTS.pages[1] },
];
const RECENT: RecentEntry = {
    kind: 'page',
    href: '/admin/system/cost',
    label: 'Cost',
    sectionLabel: 'System',
    timestamp: 1,
};

afterEach(() => cleanup());

describe('AdminCommandResultsList', () => {
    test('renders "No results" when flat is empty', () => {
        render(AdminCommandResultsList, {
            recents: [],
            results: { pages: [], settings: [], providers: [] },
            flat: [],
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 0,
            providersOffset: 0,
            onhoverindex: vi.fn(),
            onactivate: vi.fn(),
        });
        expect(screen.getByText('No results')).toBeTruthy();
    });

    test('a tab result shows its parent page before its own title', () => {
        render(AdminCommandResultsList, {
            recents: [],
            results: RESULTS,
            flat: FLAT,
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 2,
            providersOffset: 2,
            onhoverindex: vi.fn(),
            onactivate: vi.fn(),
        });
        expect(screen.getByText('System Health ›')).toBeTruthy();
        expect(screen.getByText('Cluster')).toBeTruthy();
    });

    test('renders a "Pages" group with the page title', () => {
        render(AdminCommandResultsList, {
            recents: [],
            results: RESULTS,
            flat: FLAT,
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 1,
            providersOffset: 1,
            onhoverindex: vi.fn(),
            onactivate: vi.fn(),
        });
        expect(screen.getByText('Pages')).toBeTruthy();
        expect(screen.getByText('System Health')).toBeTruthy();
    });

    test('clicking a row calls onactivate with that flat item', async () => {
        const onactivate = vi.fn();
        render(AdminCommandResultsList, {
            recents: [],
            results: RESULTS,
            flat: FLAT,
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 1,
            providersOffset: 1,
            onhoverindex: vi.fn(),
            onactivate,
        });
        await fireEvent.click(screen.getByText('System Health'));
        expect(onactivate).toHaveBeenCalledWith(FLAT[0]);
    });

    test('mousemove over a row calls onhoverindex with its index', async () => {
        const onhoverindex = vi.fn();
        render(AdminCommandResultsList, {
            recents: [],
            results: RESULTS,
            flat: FLAT,
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 1,
            providersOffset: 1,
            onhoverindex,
            onactivate: vi.fn(),
        });
        await fireEvent.mouseMove(screen.getByText('System Health'));
        expect(onhoverindex).toHaveBeenCalledWith(0);
    });

    test('renders a "Recent" group above "Pages" when recents are present', () => {
        const flatWithRecent: FlatPaletteItem[] = [
            { kind: 'recent', href: RECENT.href, entry: RECENT },
            ...FLAT,
        ];
        render(AdminCommandResultsList, {
            recents: [RECENT],
            results: RESULTS,
            flat: flatWithRecent,
            selectedIndex: 0,
            pagesOffset: 1,
            settingsOffset: 2,
            providersOffset: 2,
            onhoverindex: vi.fn(),
            onactivate: vi.fn(),
        });
        expect(screen.getByText('Recent')).toBeTruthy();
        expect(screen.getByText('Cost')).toBeTruthy();
        expect(screen.getByText('System Health')).toBeTruthy();
    });

    test('clicking a recent row calls onactivate with the recent flat item', async () => {
        const onactivate = vi.fn();
        const recentItem: FlatPaletteItem = { kind: 'recent', href: RECENT.href, entry: RECENT };
        render(AdminCommandResultsList, {
            recents: [RECENT],
            results: RESULTS,
            flat: [recentItem, ...FLAT],
            selectedIndex: 0,
            pagesOffset: 1,
            settingsOffset: 2,
            providersOffset: 2,
            onhoverindex: vi.fn(),
            onactivate,
        });
        await fireEvent.click(screen.getByText('Cost'));
        expect(onactivate).toHaveBeenCalledWith(recentItem);
    });

    test('omits the "Recent" group when recents is empty', () => {
        render(AdminCommandResultsList, {
            recents: [],
            results: RESULTS,
            flat: FLAT,
            selectedIndex: 0,
            pagesOffset: 0,
            settingsOffset: 1,
            providersOffset: 1,
            onhoverindex: vi.fn(),
            onactivate: vi.fn(),
        });
        expect(screen.queryByText('Recent')).toBeNull();
    });
});
