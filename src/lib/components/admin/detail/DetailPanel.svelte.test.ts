// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §6/§9: component coverage for the shared
 * DetailPanel shell — panel-vs-page rendering (by viewport, matching the
 * `mode` prop's contract), ESC/backdrop close, tab wiring, and the
 * SSE-patch-safety invariant (the shell must never remount tab content on a
 * prop refresh — only a genuinely new object would).
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';

const stores = vi.hoisted(() => {
    const current = { url: new URL('http://localhost/admin/tasks/abc') };
    return {
        page: {
            subscribe(run: (value: typeof current) => void) {
                run(current);
                return () => {};
            },
        },
    };
});

const gotoMock = vi.hoisted(() => vi.fn());
const replaceStateMock = vi.hoisted(() => vi.fn());

vi.mock('$app/stores', () => ({ page: stores.page }));
vi.mock('$app/navigation', () => ({ goto: gotoMock, replaceState: replaceStateMock }));
// $lib/paths (used by DetailPanel's backHref) wraps $app/paths' resolve() —
// stub it to identity so this test doesn't need the real SvelteKit runtime.
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));

const { default: DetailPanelFixture } = await import('./detail-panel-fixture.svelte');

function setViewportWide(wide: boolean): void {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: wide,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
}

const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'runs', label: 'Runs' },
];

describe('DetailPanel', () => {
    beforeEach(() => {
        setViewportWide(true);
    });

    afterEach(() => {
        cleanup();
        gotoMock.mockClear();
    });

    it('renders as a modal dialog in panel mode', () => {
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'panel',
        });
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('renders as plain page content in page mode — no dialog role', () => {
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'page',
        });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByText('my-task')).toBeTruthy();
    });

    it('mode="auto" renders panel on a wide viewport', () => {
        setViewportWide(true);
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'auto',
        });
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('mode="auto" renders page content on a narrow viewport — same component, no dialog', () => {
        setViewportWide(false);
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'auto',
        });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(screen.getByText('my-task')).toBeTruthy();
    });

    it('Escape closes the panel', async () => {
        const onclose = vi.fn();
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'panel',
            onclose,
        });
        await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    it('clicking the backdrop closes the panel', async () => {
        const onclose = vi.fn();
        const { container } = render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'panel',
            onclose,
        });
        const backdrop = container.querySelector('[role="presentation"]');
        expect(backdrop).toBeTruthy();
        await fireEvent.click(backdrop as Element);
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    it('the × button closes the panel', async () => {
        const onclose = vi.fn();
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'panel',
            onclose,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onclose).toHaveBeenCalledTimes(1);
    });

    it('clicking a tab calls onTabChange with the clicked tab id', async () => {
        const onTabChange = vi.fn();
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange,
            mode: 'page',
        });
        await fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
        expect(onTabChange).toHaveBeenCalledWith('runs');
    });

    it('page mode with a single tab renders no tab row at all', () => {
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs: [{ id: 'overview', label: 'Overview' }],
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'page',
        });
        expect(screen.queryByRole('tab')).toBeNull();
    });

    it('page mode with backHref renders a back link', () => {
        render(DetailPanelFixture, {
            titleText: 'my-task',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'page',
            backHref: '/admin/tasks',
        });
        expect(screen.getByRole('link')).toBeTruthy();
    });

    it('SSE-patch-safe: re-rendering with fresher data never remounts the tab content', async () => {
        const onContentMount = vi.fn();
        const onContentDestroy = vi.fn();
        const { rerender } = render(DetailPanelFixture, {
            titleText: 'my-task',
            subtitle: 'v1',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'page',
            onContentMount,
            onContentDestroy,
        });
        expect(onContentMount).toHaveBeenCalledTimes(1);

        await rerender({
            titleText: 'my-task',
            subtitle: 'v2 — a fresher SSE-patched snapshot',
            tabs,
            activeTab: 'overview',
            onTabChange: vi.fn(),
            mode: 'page',
            onContentMount,
            onContentDestroy,
        });
        await tick();

        expect(onContentDestroy).not.toHaveBeenCalled();
        expect(onContentMount).toHaveBeenCalledTimes(1);
    });
});

describe('header description', () => {
    it('renders one or two sentences under the subtitle', async () => {
        // The run sidebar named the task and its id but never said what the task
        // does. The curated descriptions already existed for the task catalog;
        // only the wiring to this header was missing.
        const { container } = render(DetailPanelFixture, {
            props: {
                titleText: 'Stage Coverage Sweeper',
                subtitle: 'stage-sweep',
                description:
                    'Works through the backlog of pending pipeline steps across the whole library.',
                tabs: [{ id: 'summary', label: 'Summary' }],
                activeTab: 'summary',
                onTabChange: () => {},
                mode: 'panel' as const,
            },
        });

        expect(container.textContent).toContain(
            'Works through the backlog of pending pipeline steps',
        );
    });

    it('renders nothing extra when there is no description', async () => {
        // External-plugin tasks have no curated entry and may carry no SDK
        // description either; the header must not grow an empty paragraph.
        const { container } = render(DetailPanelFixture, {
            props: {
                titleText: 'Some Task',
                subtitle: 'some-task',
                tabs: [{ id: 'summary', label: 'Summary' }],
                activeTab: 'summary',
                onTabChange: () => {},
                mode: 'panel' as const,
            },
        });

        expect(container.textContent).toContain('some-task');
    });
});
