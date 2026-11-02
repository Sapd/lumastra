// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminAuditFeed from './AdminAuditFeed.svelte';
import type { AdminAuditFeedResponse } from '$lib/schemas/admin-audit.schema';

const api = vi.hoisted(() => ({ feed: vi.fn(), actors: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({
    getAdminAuditFeed: api.feed,
    getAdminAuditActors: api.actors,
}));
vi.mock('$app/paths', () => ({ base: '/lumastra' }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts }));

function deferred() {
    let resolve!: (value: { data?: AdminAuditFeedResponse; error?: string }) => void;
    const promise = new Promise<{ data?: AdminAuditFeedResponse; error?: string }>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function response(target: string, cursor?: string) {
    return {
        data: {
            items: [
                {
                    id: 1,
                    ts: '2026-09-29T12:00:00Z',
                    instanceId: 'test',
                    actor: 'admin',
                    principalKind: null,
                    credentialId: null,
                    action: 'user.update',
                    target,
                    outcome: 'ok' as const,
                    detail: {},
                },
            ],
            page: { limit: 50, hasMore: !!cursor, nextCursor: cursor },
        },
    };
}
beforeEach(() => {
    api.feed.mockReset();
    api.actors.mockResolvedValue({ data: { actors: [] } });
});
afterEach(cleanup);

it('keeps the newest filter results when an older request finishes late', async () => {
    const old = deferred();
    const current = deferred();
    api.feed.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(AdminAuditFeed);
    await fireEvent.click(screen.getByRole('button', { name: '24h' }));
    current.resolve(response('Current result'));
    await waitFor(() => expect(screen.getByText('→ Current result')).toBeTruthy());
    old.resolve({ error: 'Old request failed' });
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Old request failed')).toBeNull();
    expect(screen.getByText('→ Current result')).toBeTruthy();
});

it('does not append an old page after changing filters', async () => {
    const oldPage = deferred();
    api.feed
        .mockResolvedValueOnce(response('Initial', '50'))
        .mockReturnValueOnce(oldPage.promise)
        .mockResolvedValueOnce(response('Filtered'));
    render(AdminAuditFeed);
    await fireEvent.click(await screen.findByRole('button', { name: /load more/i }));
    await fireEvent.click(screen.getByRole('button', { name: '7d' }));
    await screen.findByText('→ Filtered');
    oldPage.resolve(response('Wrong page'));
    await waitFor(() => expect(api.feed).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('→ Wrong page')).toBeNull();
    expect(screen.getByText('→ Filtered')).toBeTruthy();
});

it('warns when the CSV export was cut at the row limit', async () => {
    api.feed.mockResolvedValue(response('Row'));
    const fetchMock = vi.fn(
        async () =>
            new Response('id\n1\n', { headers: { 'X-Truncated': 'true', 'X-Next-Cursor': '1' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    render(AdminAuditFeed);

    await fireEvent.click(await screen.findByRole('button', { name: /export csv/i }));

    await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('format=csv');
    vi.unstubAllGlobals();
});
