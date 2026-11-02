// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { page } from '$app/state';
import { goto, invalidateAll, pushState, replaceState } from '$app/navigation';
import type { LocalUser } from '$lib/schemas/api-admin-responses';
import type { PageData } from './$types';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));
vi.mock('$app/state', async () => {
    const { fromStore, writable } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new URL('http://localhost:3000/admin/users'),
            data: { user: { username: 'operator' }, features: {} },
            get state(): App.PageState {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    const { page } = await import('$app/state');
    return { page: readable(page), navigating: readable(null) };
});
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        // SvelteKit shallow navigation changes history and reactive page.state,
        // NOT page.url. Updating page.url here would hide the original bug.
        pushState: vi.fn((url: string | URL, state: App.PageState): void => {
            window.history.pushState(state, '', new URL(String(url), page.url));
            page.state = state;
        }),
        replaceState: vi.fn((url: string | URL, state: App.PageState): void => {
            window.history.replaceState(state, '', new URL(String(url), page.url));
            page.state = state;
        }),
        goto: vi.fn(),
        invalidateAll: vi.fn(),
    };
});

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({
    apiGet: apiRequest,
    apiPost: apiRequest,
    apiPut: apiRequest,
    apiPatch: apiRequest,
    apiDelete: apiRequest,
}));

// Import the actual route, table, drawer, and workspace URL helper.
import UsersPage from './+page.svelte';

const users: LocalUser[] = [
    {
        id: '11111111-1111-4111-8111-000000000001',
        username: 'alice',
        displayName: 'Alice Admin',
        email: 'alice@example.test',
        isAdmin: true,
        adminPinned: true,
        maxAgeRating: null,
        ageRatingPinned: false,
        hideStreams: false,
        groups: [],
        createdAt: '2026-01-01T00:00:00Z',
        disabled: false,
        hasNativePassword: true,
    },
    {
        id: '11111111-1111-4111-8111-000000000002',
        username: 'bob',
        displayName: 'Bob Member',
        email: 'bob@example.test',
        isAdmin: false,
        adminPinned: false,
        maxAgeRating: null,
        ageRatingPinned: false,
        hideStreams: false,
        groups: [],
        createdAt: '2026-02-01T00:00:00Z',
        disabled: false,
        hasNativePassword: true,
    },
];

function restoreShallowState(event: PopStateEvent): void {
    // Stand in for SvelteKit's popstate handler, including empty initial state.
    page.state = (event.state ?? {}) as App.PageState;
}

function renderPage(search = ''): URL {
    page.url = new URL(`/admin/users${search}`, window.location.origin) as typeof page.url;
    window.history.replaceState({}, '', page.url);
    render(UsersPage, { props: { data: { initialUsers: users } as PageData } });
    return page.url;
}

function expectShallowUrl(routeUrl: URL, search: string): void {
    expect(page.url).toBe(routeUrl);
    expect(window.location.search).toBe(search);
    expect(page.state.adminWorkspaceUrl).toBe(window.location.href);
}

async function traverseHistory(direction: 'back' | 'forward'): Promise<void> {
    const restored = new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
    });
    window.history[direction]();
    await restored;
    await tick();
}

beforeEach(() => {
    vi.clearAllMocks();
    page.state = {};
    apiRequest.mockResolvedValue({ data: null, error: null, status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected network request')));
    window.addEventListener('popstate', restoreShallowState);
});

afterEach(() => {
    cleanup();
    window.removeEventListener('popstate', restoreShallowState);
    expect(goto).not.toHaveBeenCalled();
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

describe('/admin/users shallow navigation', () => {
    it('opens the real drawer on a row click and restores selection with Back/Forward', async () => {
        const routeUrl = renderPage();
        expect(screen.queryByRole('dialog')).toBeNull();

        await fireEvent.click(screen.getByRole('button', { name: 'View details for alice' }));

        const drawer = screen.getByRole('dialog', { name: 'View details for alice' });
        expect(within(drawer).getByText('Alice Admin')).toBeTruthy();
        expect(pushState).toHaveBeenCalledTimes(1);
        expectShallowUrl(routeUrl, '?user=alice');
        expect(routeUrl.search).toBe('');

        await traverseHistory('back');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(page.url).toBe(routeUrl);
        expect(page.state).toEqual({});
        expect(window.location.search).toBe('');

        await traverseHistory('forward');
        expect(screen.getByRole('dialog', { name: 'View details for alice' })).toBeTruthy();
        expectShallowUrl(routeUrl, '?user=alice');

        await fireEvent.click(
            within(screen.getByRole('dialog')).getByRole('button', { name: 'Close details' }),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(replaceState).toHaveBeenCalledTimes(1);
        expectShallowUrl(routeUrl, '');

        // Closing replaces the selected entry: going back and forward must not
        // resurrect the dismissed drawer.
        await traverseHistory('back');
        await traverseHistory('forward');
        expect(screen.queryByRole('dialog')).toBeNull();
        expectShallowUrl(routeUrl, '');
    });

    it('closes a directly linked drawer even though page.url still contains its selection', async () => {
        const routeUrl = renderPage('?user=bob&sort=name');
        const drawer = screen.getByRole('dialog', { name: 'View details for bob' });

        await fireEvent.click(within(drawer).getByRole('button', { name: 'Close details' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expectShallowUrl(routeUrl, '?sort=name');
        expect(routeUrl.search).toBe('?user=bob&sort=name');
        expect(replaceState).toHaveBeenCalledTimes(1);
    });

    it('closes the drawer and clears ?user= after deleting that user', async () => {
        const routeUrl = renderPage('?user=bob&sort=name');
        const drawer = screen.getByRole('dialog', { name: 'View details for bob' });
        const deleteButton =
            within(drawer).queryByRole('button', { name: 'Delete' }) ??
            (await (async () => {
                await fireEvent.click(within(drawer).getByRole('tab', { name: /Access/ }));
                return within(drawer).getByRole('button', { name: 'Delete' });
            })());
        await fireEvent.click(deleteButton);
        await fireEvent.input(screen.getByPlaceholderText('bob'), { target: { value: 'bob' } });
        // The real DeleteLocalUserResponseSchema shape.
        apiRequest.mockResolvedValueOnce({
            data: {
                username: 'bob',
                deleted: true,
                erasure: { totalDeleted: 3, totalAnonymized: 1, tables: {} },
            },
            error: null,
            status: 200,
        });

        await fireEvent.click(screen.getByRole('button', { name: 'Delete user' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByText(/not found/i)).toBeNull();
        expectShallowUrl(routeUrl, '?sort=name');
        // The one expected request: the delete itself.
        expect(apiRequest).toHaveBeenCalledTimes(1);
        apiRequest.mockClear();
    });

    it('offers row quick actions that route through the same confirmations', async () => {
        renderPage();
        const trigger = screen.getByRole('button', { name: 'Quick actions for bob' });

        await fireEvent.click(trigger);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);

        await fireEvent.click(trigger);
        await fireEvent.click(screen.getByRole('menuitem', { name: 'Grant administrator access' }));
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByText('Change administrator access?')).toBeTruthy();
        // Nothing opened the drawer, and nothing was sent before confirming.
        expect(screen.queryByRole('dialog', { name: /View details/ })).toBeNull();
        expect(apiRequest).not.toHaveBeenCalled();
    });

    it('offers disabling from the row, behind the disable confirmation', async () => {
        renderPage();
        await fireEvent.click(screen.getByRole('button', { name: 'Quick actions for bob' }));
        await fireEvent.click(screen.getByRole('menuitem', { name: 'Disable account' }));
        expect(screen.getByText('Disable bob')).toBeTruthy();
        expect(apiRequest).not.toHaveBeenCalled();
    });

    it('keeps the disable confirmation open when the server refuses', async () => {
        renderPage();
        await fireEvent.click(screen.getByRole('button', { name: 'Quick actions for bob' }));
        await fireEvent.click(screen.getByRole('menuitem', { name: 'Disable account' }));
        apiRequest.mockResolvedValueOnce({
            data: null,
            error: 'Cannot disable the last active admin',
            status: 409,
        });

        await fireEvent.click(screen.getByRole('button', { name: 'Disable account' }));

        await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
        await tick();
        expect(screen.getByText('Disable bob')).toBeTruthy();
        apiRequest.mockClear();
    });

    it('marks the account as having a password after an admin sets one', async () => {
        const noPassword = users.map((u) =>
            u.username === 'bob' ? { ...u, hasNativePassword: false } : u,
        );
        page.url = new URL('/admin/users?user=bob', window.location.origin) as typeof page.url;
        window.history.replaceState({}, '', page.url);
        render(UsersPage, { props: { data: { initialUsers: noPassword } as PageData } });
        const drawer = screen.getByRole('dialog', { name: 'View details for bob' });
        await fireEvent.click(within(drawer).getByRole('tab', { name: /Access/ }));
        await fireEvent.click(within(drawer).getByRole('button', { name: 'Set password' }));

        const field = document.querySelector('input[type="password"]') as HTMLInputElement;
        await fireEvent.input(field, { target: { value: 'Tq8#vLm2!xRz7@pWk-orbit-lantern' } });
        apiRequest.mockResolvedValueOnce({
            data: { username: 'bob', passwordChanged: true },
            error: null,
            status: 200,
        });
        const submit = screen
            .getAllByRole('button', { name: 'Set password' })
            .find((b) => !drawer.contains(b))!;
        expect((submit as HTMLButtonElement).disabled).toBe(false);
        await fireEvent.click(submit);

        await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
        await waitFor(() =>
            expect(within(drawer).queryByRole('button', { name: 'Set password' })).toBeNull(),
        );
        expect(drawer.querySelector('img')?.getAttribute('src')).toContain(
            `/api/users/${users[1].id}/images/avatar?`,
        );
        apiRequest.mockClear();
    });

    it('applies filters and search immediately and preserves them when opening and closing details', async () => {
        const routeUrl = renderPage();
        const admins = screen.getByRole('button', { name: /^Admins/ });

        await fireEvent.click(admins);

        expect(admins.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'View details for alice' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'View details for bob' })).toBeNull();
        expectShallowUrl(routeUrl, '?filter=admins');

        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'bob' } });
        expect(screen.queryByRole('button', { name: 'View details for alice' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'View details for bob' })).toBeNull();
        expectShallowUrl(routeUrl, '?filter=admins&q=bob');

        await fireEvent.click(screen.getByRole('button', { name: /^All\s/ }));
        expect(screen.getByRole('button', { name: 'View details for bob' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'View details for alice' })).toBeNull();
        expectShallowUrl(routeUrl, '?q=bob');

        await fireEvent.click(screen.getByRole('button', { name: 'View details for bob' }));
        const drawer = screen.getByRole('dialog', { name: 'View details for bob' });
        expectShallowUrl(routeUrl, '?q=bob&user=bob');
        await fireEvent.click(within(drawer).getByRole('button', { name: 'Close details' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expectShallowUrl(routeUrl, '?q=bob');
        expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('bob');
        expect(screen.queryByRole('button', { name: 'View details for alice' })).toBeNull();

        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
        expect(screen.getByRole('button', { name: 'View details for alice' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'View details for bob' })).toBeTruthy();
        expectShallowUrl(routeUrl, '');
        expect(routeUrl.search).toBe('');
    });
});

describe('first-install account guidance', () => {
    it('shows the built-in-login warning in the create modal even with no SSO accounts', async () => {
        page.url = new URL('/admin/users', window.location.origin) as typeof page.url;
        render(UsersPage, {
            props: { data: { initialUsers: users, nativeLoginEnabled: false } as PageData },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
        expect(screen.getByText(/Enable built-in login/)).toBeTruthy();
        expect(screen.getByLabelText('Email (optional)')).toBeTruthy();
    });
    it('warns about possible suffix duplicates on the initial list', () => {
        page.url = new URL('/admin/users', window.location.origin) as typeof page.url;
        render(UsersPage, {
            props: {
                data: {
                    initialUsers: [...users, { ...users[1], id: 'other', username: 'bob-2' }],
                } as PageData,
            },
        });
        expect(screen.getByText(/AUTH_OIDC_LINK_BY_USERNAME/)).toBeTruthy();
        expect(screen.getByText(/bob.*bob-2/)).toBeTruthy();
    });
});

it('creates once, sends email, and keeps the returned warning visible until Done', async () => {
    renderPage();
    await fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'anna' } });
    await fireEvent.input(screen.getByLabelText('Email (optional)'), {
        target: { value: 'anna@example.test' },
    });
    await fireEvent.input(document.querySelector('input[autocomplete="new-password"]')!, {
        target: { value: 'Tq8#vLm2!xRz7@pWk-orbit-lantern' },
    });
    apiRequest.mockResolvedValueOnce({
        data: { user: { username: 'anna', isAdmin: false }, warnings: ['native_login_disabled'] },
        error: null,
        status: 201,
    });
    apiRequest.mockResolvedValueOnce({
        data: { items: users, page: { limit: users.length, offset: 0, hasMore: false } },
        error: null,
        status: 200,
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy());
    expect(screen.getByText(/Enable built-in login/)).toBeTruthy();
    expect(document.querySelector('input[autocomplete="new-password"]')).toBeNull();
    expect(apiRequest.mock.calls[0][2]).toMatchObject({ email: 'anna@example.test' });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    await fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/Enable built-in login/)).toBeNull();
    expect(apiRequest).toHaveBeenCalledTimes(2);
    apiRequest.mockClear();
});

it('rejects invalid create email with an actionable message before submission', async () => {
    renderPage();
    await fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await fireEvent.input(screen.getByLabelText('Email (optional)'), {
        target: { value: 'https://secret:password@example.test' },
    });
    expect(screen.getByRole('alert').textContent).toBe(
        'Enter a valid email address, or leave the field empty.',
    );
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
        true,
    );
    expect(apiRequest).not.toHaveBeenCalled();
});
