// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import Runs from './+page.svelte';
vi.mock('$lib/components/ui/index.js', async () => ({
    Tabs: (await import('$lib/components/ui/Tabs.svelte')).default,
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
const state = vi.hoisted(() => ({ goto: vi.fn() }));
const route = writable({ url: new URL('http://localhost/admin/tasks/runs'), data: {}, state: {} });
vi.mock('$app/stores', () => ({
    page: { subscribe: (fn: Parameters<typeof route.subscribe>[0]) => route.subscribe(fn) },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({
    runSSEBus: { connect: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('$lib/stores/run-detail-panel.js', async () => {
    const { writable } = await import('svelte/store');
    return { runDetailPanel: { ...writable({ runId: null }), open: vi.fn(), close: vi.fn() } };
});
vi.mock('$lib/components/admin/runs/RunList.svelte', async () => ({
    default: (await import('./__fixtures__/RunListProbe.svelte')).default,
}));
vi.mock('$lib/components/admin/index.js', async () => ({
    AdminPageHeader: (await import('../../library/media/__fixtures__/EmptyComponent.svelte'))
        .default,
}));
vi.mock('$lib/components/admin/runs/RunServersRail.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/runs/RunErrorFeedRail.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/runs/RunDetailPanel.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/HelpPopover.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
function navigate(search: string) {
    route.set({ url: new URL('http://localhost/admin/tasks/runs' + search), data: {}, state: {} });
}
function list() {
    return JSON.parse(screen.getByTestId('run-list').textContent ?? '{}');
}
beforeEach(() => {
    state.goto.mockClear();
    navigate('');
});
afterEach(cleanup);
it('honors same-route navigation filters without rewriting them', async () => {
    render(Runs);
    await tick();
    navigate('?status=failed&since=7d&view=all');
    await tick();
    expect(list()).toMatchObject({ stateFilter: ['failed', 'cancelled'], sinceWindow: '7d' });
    expect(state.goto).not.toHaveBeenCalled();
});
it('remounts when the task scope changes and retains the selected time window', async () => {
    navigate('?taskId=first&since=all');
    render(Runs);
    await tick();
    navigate('?taskId=second&since=all');
    await tick();
    expect(list()).toMatchObject({ taskId: 'second', mountedTask: 'second', sinceWindow: 'all' });
    await fireEvent.click(screen.getByRole('button', { name: 'Seven days' }));
    expect(state.goto).toHaveBeenCalledWith(
        '/admin/tasks/runs?taskId=second&since=7d',
        expect.anything(),
    );
});
