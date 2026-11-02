// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UserDetailDrawer from './UserDetailDrawer.svelte';
import type { LocalUser } from '$lib/schemas/api-admin-responses';
import { loginMethods, needsLoginAttention, possibleSuffixDuplicates } from './user-directory';

vi.mock('$lib/api/user', () => ({
    uploadAvatar: vi.fn(),
    deleteAvatar: vi.fn(),
}));
// The Access-tab panels load their own data when opened; answer every admin
// call with an empty result so they render their empty states.
vi.mock('$lib/api/admin', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const empty = vi.fn(async () => ({ data: null, error: null }));
    return Object.fromEntries(
        Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? empty : v]),
    );
});
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));

const user: LocalUser = {
    id: 'test-account',
    username: 'sample',
    isAdmin: false,
    adminPinned: true,
    maxAgeRating: 12,
    ageRatingPinned: true,
    hideStreams: false,
    groups: ['Members'],
    createdAt: '2026-01-01T00:00:00Z',
    disabled: false,
    hasNativePassword: false,
};
function props(overrides: Partial<LocalUser> = {}) {
    return {
        user: { ...user, ...overrides },
        currentUsername: 'operator',
        togglingAdmin: new Set<string>(),
        updatingPrivacy: new Set<string>(),
        updatingAgeRating: new Set<string>(),
        updatingDisabled: new Set<string>(),
        deletingUser: new Set<string>(),
        formatDate: () => 'Recently',
        onToggleAdmin: vi.fn(),
        onUnpinAdmin: vi.fn(),
        onSetAgeRating: vi.fn(),
        onUnpinAgeRating: vi.fn(),
        onSetAllowLiveTv: vi.fn().mockResolvedValue(false),
        onTogglePrivacy: vi.fn(),
        onClearUserData: vi.fn(),
        onOpenQuickConnect: vi.fn(),
        onResetPassword: vi.fn(),
        onClose: vi.fn(),
    };
}
beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('user account panel', () => {
    it('sends an explicit value and restores the confirmed switch after a failed save', async () => {
        const callbacks = props();
        const view = render(UserDetailDrawer, { props: callbacks });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        await fireEvent.click(view.getByRole('switch', { name: 'Allow Live TV' }));
        expect(callbacks.onSetAllowLiveTv).toHaveBeenCalledWith('sample', false);
        expect(
            view.getByRole('switch', { name: 'Allow Live TV' }).getAttribute('aria-checked'),
        ).toBe('true');
    });
    it('does not suggest changing an explicit Live TV choice', async () => {
        const view = render(UserDetailDrawer, {
            props: props({ allowLiveTv: true, liveTvDefault: false }),
        });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        expect(
            view.queryByText('Live TV has no age filter. Consider turning it off for this user.'),
        ).toBeNull();
        expect(view.getByText('Live TV has no age filter.')).toBeTruthy();
    });

    it('offers a Live TV switch beside the age limit and suggests disabling it for restricted defaults', async () => {
        const view = render(UserDetailDrawer, { props: props() });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        expect(view.getByRole('switch', { name: 'Allow Live TV' })).toBeTruthy();
        expect(
            view.getByText('Live TV has no age filter. Consider turning it off for this user.'),
        ).toBeTruthy();
    });

    it('uses the avatar byte route and updates it when the selected account changes', async () => {
        const callbacks = props();
        const view = render(UserDetailDrawer, { props: callbacks });
        expect(view.container.querySelector('img')?.getAttribute('src')).toContain(
            '/api/users/test-account/images/avatar?',
        );

        await view.rerender({ user: { ...callbacks.user, hasNativePassword: true } });
        expect(view.container.querySelector('img')?.getAttribute('src')).toContain(
            '/api/users/test-account/images/avatar?',
        );

        await view.rerender({
            user: { ...callbacks.user, id: 'other-account', username: 'other' },
        });
        expect(view.container.querySelector('img')?.getAttribute('src')).toContain(
            '/api/users/other-account/images/avatar?',
        );
    });

    it('keeps access mutations behind the Access & sign-in section', async () => {
        const callbacks = props();
        const view = render(UserDetailDrawer, { props: callbacks });
        expect(view.queryByRole('button', { name: 'Grant administrator access' })).toBeNull();
        // The row's accessible name also carries its one-line description.
        // Connections (Overview) now jumps to Access with that panel open,
        // instead of stacking a dialog on top of the drawer.
        await fireEvent.click(view.getByRole('button', { name: /^Connections/ }));
        expect(
            view.getByRole('tab', { name: 'Access & sign-in' }).getAttribute('aria-selected'),
        ).toBe('true');
        expect(
            view.getByRole('button', { name: /^Connections/ }).getAttribute('aria-expanded'),
        ).toBe('true');
        await fireEvent.click(view.getByRole('button', { name: 'Grant administrator access' }));
        expect(callbacks.onToggleAdmin).toHaveBeenCalledWith('sample', false);
        // Requesting a change does not optimistically alter the server-confirmed role.
        expect(view.getByRole('button', { name: 'Grant administrator access' })).toBeTruthy();
        await fireEvent.click(view.getByRole('button', { name: 'Set password' }));
        expect(callbacks.onResetPassword).toHaveBeenCalledWith('sample');
    });

    it('exposes its sections as tabs with one tab stop and arrow-key movement', async () => {
        const view = render(UserDetailDrawer, { props: props() });
        const overview = view.getByRole('tab', { name: 'Overview' });
        const access = view.getByRole('tab', { name: 'Access & sign-in' });
        expect(overview.getAttribute('aria-selected')).toBe('true');
        expect(access.getAttribute('tabindex')).toBe('-1');
        expect(view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(overview.id);

        // Let the dialog's initial autofocus (close button) land first.
        await new Promise((resolve) => setTimeout(resolve, 50));
        overview.focus();
        await fireEvent.keyDown(overview, { key: 'ArrowRight' });
        expect(access.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(access);
        expect(view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(access.id);

        await fireEvent.keyDown(access, { key: 'End' });
        expect(view.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe(
            'true',
        );
        await fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
        expect(overview.getAttribute('aria-selected')).toBe('true');
    });

    it('saves an empty age limit as unrestricted, and rejects fractional ages', async () => {
        const callbacks = props();
        const view = render(UserDetailDrawer, { props: callbacks });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        const field = view.getByRole('spinbutton');
        await fireEvent.input(field, { target: { value: '' } });
        await fireEvent.blur(field);
        expect(callbacks.onSetAgeRating).toHaveBeenCalledWith('sample', null);
        callbacks.onSetAgeRating.mockClear();
        await fireEvent.input(field, { target: { value: '12.5' } });
        await fireEvent.blur(field);
        expect(callbacks.onSetAgeRating).not.toHaveBeenCalled();
        expect(field.getAttribute('aria-invalid')).toBe('true');
        await fireEvent.keyDown(field, { key: 'Escape' });
        expect(callbacks.onClose).not.toHaveBeenCalled();
        expect((field as HTMLInputElement).value).toBe('12');
    });

    it('protects the current administrator from changing their own role', async () => {
        const callbacks = props({ username: 'operator', isAdmin: true });
        const view = render(UserDetailDrawer, { props: callbacks });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        expect(
            (view.getByRole('button', { name: 'Remove administrator access' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it('treats a differently-cased username as the current administrator', async () => {
        const callbacks = props({ username: 'operator', isAdmin: true });
        const view = render(UserDetailDrawer, {
            props: { ...callbacks, currentUsername: 'Operator' },
        });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        expect(
            (view.getByRole('button', { name: 'Remove administrator access' }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it('puts the age field back to the saved value when the save fails', async () => {
        const callbacks = props();
        callbacks.onSetAgeRating.mockResolvedValue(false);
        const view = render(UserDetailDrawer, { props: callbacks });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        const field = view.getByRole('spinbutton') as HTMLInputElement;
        await fireEvent.input(field, { target: { value: '16' } });
        await fireEvent.blur(field);
        expect(callbacks.onSetAgeRating).toHaveBeenCalledWith('sample', 16);
        await vi.waitFor(() => expect(field.value).toBe('12'));
    });

    it('sends one save when Enter is followed by blur while the first is in flight', async () => {
        const callbacks = props();
        const view = render(UserDetailDrawer, {
            props: { ...callbacks, updatingAgeRating: new Set(['sample']) },
        });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        const field = view.getByRole('spinbutton') as HTMLInputElement;
        await fireEvent.input(field, { target: { value: '16' } });
        await fireEvent.blur(field);
        expect(callbacks.onSetAgeRating).not.toHaveBeenCalled();
    });

    it('flips the hide-activity switch back when the save fails', async () => {
        const callbacks = props();
        callbacks.onTogglePrivacy.mockResolvedValue(false);
        const view = render(UserDetailDrawer, { props: callbacks });
        const toggle = () => view.getByRole('switch', { name: 'Hide activity from others' });
        await fireEvent.click(toggle());
        expect(callbacks.onTogglePrivacy).toHaveBeenCalledWith('sample', false);
        await vi.waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    });

    it('flags orphan accounts without misclassifying legacy SSO users', () => {
        expect(needsLoginAttention({ ...user, groups: [] })).toBe(true);
        expect(needsLoginAttention({ ...user, groups: [], lastSeenAt: '2026-01-01' })).toBe(false);
        expect(needsLoginAttention({ ...user, groups: [], identityProviders: ['oidc'] })).toBe(
            false,
        );
        expect(needsLoginAttention(user)).toBe(false);
    });

    it('does not flag Jellyfin-only or token-only accounts, and names how they get in', () => {
        const bare = { ...user, groups: [] };
        const jellyfinOnly = { ...bare, jellyfinLinked: true };
        const tokenOnly = { ...bare, apiTokenCount: 1 };
        expect(needsLoginAttention(jellyfinOnly)).toBe(false);
        expect(needsLoginAttention(tokenOnly)).toBe(false);
        expect(loginMethods(jellyfinOnly)).toBe('Jellyfin server only');
        expect(loginMethods(tokenOnly)).toBe('API token only');
        // A real Lumastra sign-in wins over the Jellyfin link.
        expect(loginMethods({ ...jellyfinOnly, identityProviders: ['forward_auth'] })).toBe(
            'Proxy sign-in',
        );
    });

    it('labels sign-in and playback separately instead of one contradictory "last seen"', () => {
        const view = render(
            UserDetailDrawer,
            props({
                groups: [],
                jellyfinLinked: true,
                lastActivityAt: '2026-09-25T20:40:30Z',
                lastActivitySource: 'jellyfin',
            }),
        );
        const line = view
            .getByText(/Never signed in to Lumastra/)
            .textContent?.replace(/\s+/g, ' ');
        expect(line).toContain('Last activity Recently');
        expect(line).toContain('via Jellyfin server');
        expect(line).not.toContain('Last seen');
    });

    it('says a group-less account is on the defaults, not "from identity provider groups"', async () => {
        const view = render(
            UserDetailDrawer,
            props({ groups: [], adminPinned: false, ageRatingPinned: false }),
        );
        expect(view.queryByText('From identity provider groups')).toBeNull();
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        expect(view.getAllByText('Default — no identity provider groups').length).toBe(2);
        expect(view.queryByText('From identity provider groups')).toBeNull();
    });

    it('expands identities and stream policy in place, not as dialogs', async () => {
        const view = render(UserDetailDrawer, { props: props() });
        await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
        for (const name of [/^Identities/, /^Stream policy/]) {
            const toggle = view.getByRole('button', { name });
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            await fireEvent.click(toggle);
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
        }
        // In place: no modal dialog besides the drawer itself.
        expect(view.getAllByRole('dialog')).toHaveLength(1);
    });

    it('opens on the section it is given and reports tab changes', async () => {
        const onSectionChange = vi.fn();
        const view = render(UserDetailDrawer, {
            ...props(),
            section: 'activity' as const,
            onSectionChange,
        });
        expect(view.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe(
            'true',
        );
        await fireEvent.click(view.getByRole('tab', { name: 'Overview' }));
        expect(onSectionChange).toHaveBeenCalledWith('overview');
    });
});

it('edits the SSO matching email and explains age-limit scope', async () => {
    const onSetEmail = vi.fn().mockResolvedValue(true);
    const view = render(UserDetailDrawer, { props: { ...props(), onSetEmail } });
    await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
    const email = view.getByLabelText('Email (optional)');
    await fireEvent.input(email, { target: { value: 'anna@example.test' } });
    await fireEvent.click(view.getByRole('button', { name: 'Save email' }));
    expect(onSetEmail).toHaveBeenCalledWith('sample', 'anna@example.test');
    expect(view.getByText(/Unrated content is hidden by default/)).toBeTruthy();
    expect(view.getByText(/Live TV has no age restriction/)).toBeTruthy();
    expect(view.getByText(/New libraries are visible to everyone/)).toBeTruthy();
});

it('shows how many library titles have no age rating next to the age limit', async () => {
    const view = render(UserDetailDrawer, {
        props: { ...props(), unratedTitles: { unrated: 12, total: 340 } },
    });
    await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
    expect(view.getByTestId('unrated-title-count').textContent).toMatch(
        /12 of 340 library titles have no age rating, so age-limited users cannot see them/,
    );
    cleanup();

    const visible = render(UserDetailDrawer, {
        props: { ...props(), unratedTitles: { unrated: 3, total: 10 }, unratedContentVisible: true },
    });
    await fireEvent.click(visible.getByRole('tab', { name: 'Access & sign-in' }));
    expect(visible.getByTestId('unrated-title-count').textContent).toMatch(
        /3 of 10 library titles have no age rating\. Age-limited users can see them/,
    );
    cleanup();

    const none = render(UserDetailDrawer, {
        props: { ...props(), unratedTitles: { unrated: 0, total: 10 } },
    });
    await fireEvent.click(none.getByRole('tab', { name: 'Access & sign-in' }));
    expect(none.queryByTestId('unrated-title-count')).toBeNull();
});

it('does not submit invalid email, and retains the edit when saving fails', async () => {
    const onSetEmail = vi.fn().mockResolvedValue(false);
    const view = render(UserDetailDrawer, { props: { ...props(), onSetEmail } });
    await fireEvent.click(view.getByRole('tab', { name: 'Access & sign-in' }));
    const field = view.getByLabelText('Email (optional)');
    await fireEvent.input(field, { target: { value: 'https://secret:password@example.test' } });
    expect(view.getByRole('alert').textContent).toBe(
        'Enter a valid email address, or leave the field empty.',
    );
    expect((view.getByRole('button', { name: 'Save email' }) as HTMLButtonElement).disabled).toBe(
        true,
    );
    expect(onSetEmail).not.toHaveBeenCalled();
    await fireEvent.input(field, { target: { value: 'anna@example.test' } });
    await fireEvent.click(view.getByRole('button', { name: 'Save email' }));
    expect((field as HTMLInputElement).value).toBe('anna@example.test');
    expect(view.getByRole('alert').textContent).toBe('Could not save the email. Try again.');
});

it('flags only provisioner-style suffixes with an existing base account', () => {
    const records = ['anna', 'anna-2', 'anna-10', 'anna-1', 'anna-02', 'unrelated-2'].map(
        (username) => ({ ...user, username }),
    );
    expect(possibleSuffixDuplicates(records)).toEqual([
        { original: 'anna', duplicate: 'anna-2' },
        { original: 'anna', duplicate: 'anna-10' },
    ]);
});
