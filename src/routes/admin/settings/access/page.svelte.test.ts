// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import AccessPage from './+page.svelte';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({
    apiGet: api.get,
    apiPatch: api.patch,
    apiPost: api.post,
    apiDelete: api.delete,
}));
vi.mock('$lib/components/admin', async () => ({
    AdminSettingsPage: (await import('./__fixtures__/SettingsShell.svelte')).default,
    SettingSection: (await import('../../library/media/__fixtures__/EmptyComponent.svelte'))
        .default,
}));
vi.mock('$lib/components/admin/settings/AuthDiagnosticsPanel.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/settings/SocialAudiencePanel.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/config/schema', () => ({
    getGroupReferencingSettings: () => [],
    isSettingVisible: () => true,
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

const groups = ['Alpha', 'Beta'].map((name, i) => ({
    id: `group-${i}`,
    name,
    displayName: name,
    isSystem: false,
    memberCount: 1,
    capabilities: [],
    createdAt: '',
    updatedAt: '',
}));
function deferred() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}
function mount() {
    return render(AccessPage, {
        data: { initialGroups: groups },
        form: null,
    } as unknown as ComponentProps<typeof AccessPage>);
}
function groupCard(name: string) {
    const card = screen.getByRole('heading', { name }).closest('.card');
    if (!card) throw new Error('Missing group card');
    return within(card as HTMLElement);
}
async function open(name: string) {
    await fireEvent.click(groupCard(name).getByRole('button', { name: 'Members' }));
}
const memberData = (name: string) => ({
    data: {
        items: [{ userId: `${name}-id`, username: name, displayName: name }],
        page: { limit: 50, hasMore: false },
    },
});
beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

it('ignores a previous group’s delayed member list', async () => {
    const alpha = deferred();
    const beta = deferred();
    api.get.mockReturnValueOnce(alpha.promise).mockReturnValueOnce(beta.promise);
    mount();
    await open('Alpha');
    await open('Beta');
    beta.resolve(memberData('Beta member'));
    await tick();
    expect(groupCard('Beta').getByText('Beta member')).toBeTruthy();
    alpha.resolve(memberData('Alpha member'));
    await tick();
    expect(screen.queryByText('Alpha member')).toBeNull();
    expect(groupCard('Beta').getByText('Beta member')).toBeTruthy();
});

it('clearing user search discards its in-flight suggestions', async () => {
    vi.useFakeTimers();
    const search = deferred();
    api.get.mockResolvedValueOnce(memberData('Member')).mockReturnValueOnce(search.promise);
    mount();
    await open('Alpha');
    await tick();
    const input = screen.getByRole('combobox');
    await fireEvent.input(input, { target: { value: 'alice' } });
    await vi.advanceTimersByTimeAsync(250);
    await fireEvent.input(input, { target: { value: '' } });
    search.resolve({ data: { items: [{ id: 'alice-id', username: 'alice' }] } });
    await tick();
    expect(screen.queryByRole('option')).toBeNull();
});

it('shows a failed user search as an error, not as "No users found"', async () => {
    vi.useFakeTimers();
    api.get
        .mockResolvedValueOnce(memberData('Member'))
        .mockResolvedValueOnce({ data: undefined, error: 'Search is unavailable' });
    mount();
    await open('Alpha');
    await tick();
    await fireEvent.input(screen.getByRole('combobox'), { target: { value: 'alice' } });
    await vi.advanceTimersByTimeAsync(250);
    await tick();
    expect(screen.getByRole('alert').textContent).toContain('Search is unavailable');
    expect(screen.queryByText(/No users found/)).toBeNull();
});

it('serializes capability changes and restores the confirmed value after failure', async () => {
    const pending = deferred();
    api.patch.mockReturnValueOnce(pending.promise);
    mount();
    const watch = groupCard('Alpha').getByRole('checkbox', {
        name: 'Watch (see all streams)',
    }) as HTMLInputElement;
    await fireEvent.click(watch);
    expect(watch.closest('fieldset')?.disabled).toBe(true);
    expect(watch.checked).toBe(false);
    expect(api.patch).toHaveBeenCalledTimes(1);
    pending.resolve({ error: 'Permission denied' });
    await waitFor(() => expect(watch.closest('fieldset')?.disabled).toBe(false));
    expect(watch.checked).toBe(false);
});

it.each([
    [{ kind: 'absent' }, 'Push: not configured'],
    [{ kind: 'ready' }, 'Push: configured'],
    [
        { kind: 'warning', reason: 'The push sender validates the mounted key.' },
        'Push: warning (The push sender validates the mounted key.)',
    ],
    [
        { kind: 'invalid', reason: 'APNS_KEY_ID must be 10 alphanumeric characters.' },
        'Push: invalid (APNS_KEY_ID must be 10 alphanumeric characters.)',
    ],
])('shows the server-validated APNs state %j', (apnsStatus, text) => {
    render(AccessPage, {
        data: { initialGroups: groups, apnsStatus },
        form: null,
    } as unknown as ComponentProps<typeof AccessPage>);
    expect(screen.getByText(text)).toBeTruthy();
});
