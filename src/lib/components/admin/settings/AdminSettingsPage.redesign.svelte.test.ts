// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { Cog6Tooth } from 'svelte-hero-icons';
import type { SubmitFunction } from '@sveltejs/kit';
import type { BeforeNavigate } from '@sveltejs/kit';
import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
import { page } from '$app/state';
import AdminSettingsPage from './AdminSettingsPage.svelte';

const fixture = vi.hoisted(() => ({
    sections: [
        { id: 'general', label: 'General category', description: 'General controls', order: 1 },
        { id: 'playback', label: 'Playback category', description: 'Playback controls', order: 2 },
    ] satisfies SectionDefinition[],
    settings: [
        {
            key: 'SITE_NAME',
            type: 'string',
            label: 'Site name',
            description: 'Display name',
            defaultValue: 'My Media',
            section: 'general',
        },
        {
            key: 'PLAYER_NAME',
            type: 'string',
            label: 'Player name',
            description: 'Player label',
            defaultValue: 'Default player',
            section: 'playback',
        },
    ] as SettingDefinition[],
    beforeNavigate: undefined as ((navigation: BeforeNavigate) => void) | undefined,
    goto: vi.fn(),
    enhanceCallbacks: new Map<string, SubmitFunction>(),
}));

vi.mock('$app/state', async () => {
    const { SvelteURL } = await import('svelte/reactivity');
    const { writable, fromStore } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new SvelteURL('http://localhost/admin/settings/general'),
            get state() {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        beforeNavigate: (callback: (navigation: BeforeNavigate) => void): void => {
            fixture.beforeNavigate = callback;
        },
        afterNavigate: vi.fn(),
        goto: fixture.goto,
        pushState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
        replaceState: (_url: URL, state: App.PageState): void => {
            page.state = state;
        },
    };
});
vi.mock('$app/forms', () => ({
    enhance: (form: HTMLFormElement, callback: SubmitFunction): object => {
        fixture.enhanceCallbacks.set(form.getAttribute('action') ?? '', callback);
        return { destroy(): void {} };
    },
}));
vi.mock('$lib/paths', () => ({ resolve: (path: string): string => path }));
vi.mock('$lib/config/schema', () => ({
    configSchema: fixture.settings,
    configSections: fixture.sections,
    getSettingsBySection: (id: string): SettingDefinition[] =>
        fixture.settings.filter((s) => s.section === id),
    getVisibleSettingsBySection: (id: string): SettingDefinition[] =>
        fixture.settings.filter((s) => s.section === id),
    // Same rule as the real one for showWhen, enough for the empty-section test.
    isSettingVisible: (
        setting: { showWhen?: { key: string; equals?: unknown } },
        values: Record<string, unknown>,
    ): boolean => !setting.showWhen || values[setting.showWhen.key] === setting.showWhen.equals,
    isSettingEnabled: (): boolean => true,
}));
// Use actual section/input/save/dialog components, without importing the whole admin barrel.
vi.mock('$lib/components/admin', async () => ({
    SettingSection: (await import('../SettingSection.svelte')).default,
    StickySaveBar: (await import('./StickySaveBar.svelte')).default,
    SearchInput: (await import('./SearchInput.svelte')).default,
    ActionModal: (await import('../ActionModal.svelte')).default,
}));
vi.mock('../inputs/registry', async () => {
    const { default: TextInput } = await import('../inputs/TextInput.svelte');
    return { getInputComponentForSetting: (): typeof TextInput => TextInput };
});
vi.mock('$lib/api/admin', () => ({ checkProviderHealth: vi.fn() }));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/admin-show-advanced.store', async () => {
    const { writable } = await import('svelte/store');
    return { showAdvancedSettings: writable(false) };
});
// Read the source catalog so these tests don't require regenerating shared translations.
vi.mock('$lib/paraglide/messages.js', async () => {
    const { default: messages } = await import('../../../../../messages/en.json');
    return Object.fromEntries(
        Object.entries(messages).map(([key, value]) => [
            key,
            (args: Record<string, string | number> = {}): string =>
                String(value).replace(/\{(\w+)\}/g, (_, name: string) =>
                    String(args[name] ?? `{${name}}`),
                ),
        ]),
    );
});
vi.mock('$lib/utils/admin/settings-highlight', () => ({
    scrollToSetting: vi.fn(
        async ({
            sectionId,
            expandSection,
        }: {
            sectionId: string;
            expandSection: (id: string) => void;
        }): Promise<boolean> => {
            expandSection(sectionId);
            await tick();
            return true;
        },
    ),
}));

function mountPage(
    storageStatus: { willPersist: boolean; message?: string } | null = null,
): ReturnType<typeof render> {
    return render(AdminSettingsPage, {
        data: {
            values: { SITE_NAME: 'My Media', PLAYER_NAME: 'Default player' },
            envOverrides: [],
            schema: { sections: fixture.sections, settings: fixture.settings },
            configPath: '/config/settings.json',
            storageStatus,
        },
        form: null,
        icon: Cog6Tooth,
        heading: 'Settings',
        description: 'Configure My Media',
    });
}

function pendingValues(): Record<string, unknown> {
    const input = document.querySelector<HTMLInputElement>('input[name="updates"]');
    if (!input) throw new Error('Missing save payload');
    return JSON.parse(input.value) as Record<string, unknown>;
}

function navigate(path: string): ReturnType<typeof vi.fn> {
    const cancel = vi.fn();
    if (!fixture.beforeNavigate) throw new Error('Navigation guard was not registered');
    fixture.beforeNavigate({
        type: 'goto',
        from: { url: new URL(page.url), params: {}, route: { id: null }, scroll: null },
        to: { url: new URL(path, page.url), params: {}, route: { id: null }, scroll: null },
        willUnload: false,
        complete: Promise.resolve(),
        cancel,
    });
    return cancel;
}

beforeEach(() => {
    page.state = {};
    page.url.href = 'http://localhost/admin/settings/general';
    fixture.enhanceCallbacks.clear();
    fixture.goto.mockClear();
    fixture.beforeNavigate = undefined;
});
afterEach(cleanup);

describe('settings workspace redesign', () => {
    it('shows the selected category without a collapse toggle, and keeps pending values across category switches', async () => {
        // One category renders at a time (the section nav picks it), so a collapse
        // chevron on it only hid the page's own content.
        mountPage();
        expect(
            screen.queryByRole('button', { name: /General category/, expanded: true }),
        ).toBeNull();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /Playback category/ }));
        expect(screen.queryByLabelText('Site name')).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: /General category/ }));
        expect((screen.getByLabelText('Site name') as HTMLInputElement).value).toBe('Pending name');
        expect(pendingValues().SITE_NAME).toBe('Pending name');
    });

    it('lists no category whose only rows are hidden by a showWhen condition (no empty card)', () => {
        const relay: SectionDefinition = {
            id: 'relay',
            label: 'Relay category',
            description: 'Only row depends on another setting',
            order: 3,
        };
        const hiddenRow: SettingDefinition = {
            key: 'RELAY_SWITCH',
            type: 'boolean',
            label: 'Relay switch',
            description: 'Needs the site name to be "on"',
            defaultValue: true,
            section: 'relay',
            showWhen: { key: 'SITE_NAME', equals: 'on' },
        };
        // The schema mock answers from the fixture arrays, so the extra category lives there.
        fixture.sections.push(relay);
        fixture.settings.push(hiddenRow);
        const renderWith = (siteName: string): void => {
            render(AdminSettingsPage, {
                data: {
                    values: { SITE_NAME: siteName, PLAYER_NAME: 'x', RELAY_SWITCH: true },
                    envOverrides: [],
                    schema: { sections: fixture.sections, settings: fixture.settings },
                    configPath: '/config/settings.json',
                    storageStatus: null,
                },
                form: null,
                icon: Cog6Tooth,
                heading: 'Settings',
                description: 'Configure My Media',
            });
        };
        try {
            renderWith('off');
            expect(screen.queryByRole('button', { name: /Relay category/ })).toBeNull();
            cleanup();
            renderWith('on');
            expect(screen.getByRole('button', { name: /Relay category/ })).toBeTruthy();
        } finally {
            fixture.sections.pop();
            fixture.settings.pop();
        }
    });

    it('includes snippet-owned changes from the global schema in the review', async () => {
        const extraSetting: SettingDefinition = {
            key: 'GROUP_RULE',
            type: 'string',
            label: 'Group rule',
            description: 'Cross-page rule',
            defaultValue: '',
            section: 'groups',
        };
        const afterSections = createRawSnippet<
            [{ handleChange: (key: string, value: unknown) => void }]
        >((context) => ({
            render: (): string => '<div><input aria-label="Group rule editor" /></div>',
            setup(element): () => void {
                const input = element.querySelector('input');
                if (!input) throw new Error('Missing snippet input');
                const change = (): void => context().handleChange('GROUP_RULE', input.value);
                input.addEventListener('input', change);
                return () => input.removeEventListener('input', change);
            },
        }));
        render(AdminSettingsPage, {
            data: {
                values: { SITE_NAME: 'My Media', PLAYER_NAME: 'Default player', GROUP_RULE: '' },
                envOverrides: [],
                schema: { sections: fixture.sections, settings: fixture.settings },
                allSections: {
                    sections: fixture.sections,
                    settings: [...fixture.settings, extraSetting],
                },
                configPath: '/config/settings.json',
                storageStatus: null,
            },
            form: null,
            icon: Cog6Tooth,
            heading: 'Settings',
            description: 'Configure My Media',
            afterSections,
        });
        await fireEvent.input(screen.getByLabelText('Group rule editor'), {
            target: { value: 'members' },
        });
        await fireEvent.click(screen.getByText('Review pending changes (1)'));
        expect(screen.getByRole('button', { name: 'Group rule →' })).toBeTruthy();
        expect(pendingValues().GROUP_RULE).toBe('members');
    });

    it('retains pending values in the save payload when switching categories and returning', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        await fireEvent.click(
            screen.getByRole('button', { name: 'Playback category', pressed: false }),
        );
        expect(new URL(page.state.adminWorkspaceUrl!).searchParams.get('category')).toBe(
            'playback',
        );
        expect(page.url.search).toBe('');
        expect(screen.queryByLabelText('Site name')).toBeNull();
        await fireEvent.input(screen.getByLabelText('Player name'), {
            target: { value: 'Pending player' },
        });
        expect(pendingValues()).toEqual({
            SITE_NAME: 'Pending name',
            PLAYER_NAME: 'Pending player',
        });
        await fireEvent.click(
            screen.getByRole('button', { name: /General category/, pressed: false }),
        );
        expect((screen.getByLabelText('Site name') as HTMLInputElement).value).toBe('Pending name');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(fixture.goto).not.toHaveBeenCalled();
    });

    it('reviews changes from every category and removes a reverted setting', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        await fireEvent.click(
            screen.getByRole('button', { name: 'Playback category', pressed: false }),
        );
        await fireEvent.input(screen.getByLabelText('Player name'), {
            target: { value: 'Pending player' },
        });
        const summary = screen.getByText('Review pending changes (2)');
        await fireEvent.click(summary);
        const review = summary.closest('details');
        if (!review) throw new Error('Missing change review');
        expect(within(review).getByRole('button', { name: 'Player name →' })).toBeTruthy();
        await fireEvent.click(within(review).getByRole('button', { name: 'Site name →' }));
        await tick();
        expect(new URL(page.state.adminWorkspaceUrl!).searchParams.get('category')).toBe('general');
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'My Media' },
        });
        expect(screen.getByText('Review pending changes (1)')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Site name →' })).toBeNull();
        expect(pendingValues().PLAYER_NAME).toBe('Pending player');
    });

    it('blocks internal navigation, keeps edits on cancel, and discards only on confirmation', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        expect(navigate('/admin/users')).toHaveBeenCalledOnce();
        await tick();
        const dialog = screen.getByRole('dialog', { name: 'Leave with unsaved changes?' });
        expect(fixture.goto).not.toHaveBeenCalled();
        await fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(pendingValues().SITE_NAME).toBe('Pending name');
        navigate('/admin/users?filter=active');
        await tick();
        await fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
        expect(fixture.goto).toHaveBeenCalledWith('http://localhost/admin/users?filter=active');
        expect(pendingValues()).toEqual({});
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it.each([{ key: '/', ctrlKey: false, metaKey: false }])(
        'keeps focus inside the confirmation dialog for search shortcut %j',
        async (shortcut) => {
            mountPage();
            await fireEvent.input(screen.getByLabelText('Site name'), {
                target: { value: 'Pending name' },
            });
            navigate('/admin/users');
            await tick();
            const dialog = screen.getByRole('dialog', { name: 'Leave with unsaved changes?' });
            const stay = within(dialog).getByRole('button', { name: 'Keep editing' });
            stay.focus();
            await fireEvent.keyDown(stay, shortcut);
            expect(document.activeElement).toBe(stay);
            expect(dialog.contains(document.activeElement)).toBe(true);
            expect(screen.getByRole('dialog')).toBe(dialog);
            expect(pendingValues().SITE_NAME).toBe('Pending name');
            expect(fixture.goto).not.toHaveBeenCalled();

            // After dismissal the same shortcut must work again on the page.
            await fireEvent.click(stay);
            await fireEvent.keyDown(window, shortcut);
            expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search' }));
        },
    );

    it.each([
        { key: 'k', ctrlKey: true, metaKey: false },
        { key: 'k', ctrlKey: false, metaKey: true },
    ])('leaves Ctrl/Cmd+K to the admin command palette (%j)', async (shortcut) => {
        mountPage();
        const event = new KeyboardEvent('keydown', {
            ...shortcut,
            bubbles: true,
            cancelable: true,
        });
        window.dispatchEvent(event);
        await tick();
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Search' }));
    });

    it('offers "Save and leave", which submits the pending edits instead of discarding them', async () => {
        const submit = vi
            .spyOn(HTMLFormElement.prototype, 'requestSubmit')
            .mockImplementation(() => {});
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        navigate('/admin/users');
        await tick();
        const dialog = screen.getByRole('dialog', { name: 'Leave with unsaved changes?' });
        await fireEvent.click(within(dialog).getByRole('button', { name: 'Save and leave' }));
        expect(submit).toHaveBeenCalledOnce();
        expect(pendingValues().SITE_NAME).toBe('Pending name');
        expect(fixture.goto).not.toHaveBeenCalled();
        submit.mockRestore();
    });

    it('does not clear the page search when Escape dismisses the confirmation dialog', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        const search = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;
        await fireEvent.input(search, { target: { value: 'name' } });
        navigate('/admin/users');
        await tick();
        const stay = within(screen.getByRole('dialog')).getByRole('button', {
            name: 'Keep editing',
        });
        stay.focus();
        await fireEvent.keyDown(stay, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(search.value).toBe('name');
        expect(pendingValues().SITE_NAME).toBe('Pending name');
        expect(fixture.goto).not.toHaveBeenCalled();
    });

    it('respects a search shortcut already handled by another control', async () => {
        mountPage();
        const input = screen.getByLabelText('Site name');
        input.focus();
        const event = new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });
        event.preventDefault();
        await fireEvent(input, event);
        expect(document.activeElement).toBe(input);
    });

    it('allows clean navigation and same-page hash navigation with pending edits', async () => {
        mountPage();
        expect(navigate('/admin/users')).not.toHaveBeenCalled();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Pending name' },
        });
        expect(navigate('#setting-SITE_NAME')).not.toHaveBeenCalled();
        await tick();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('does not turn unknown persistence into a confirmed storage failure', () => {
        mountPage(null);
        expect(screen.queryByText('Settings will not persist!')).toBeNull();
        expect(
            screen.getByText('Storage status is unavailable. Persistence could not be checked.'),
        ).toBeTruthy();
    });

    it('still warns when storage is confirmed not persistent', () => {
        mountPage({ willPersist: false, message: 'Temporary storage' });
        expect(screen.getByText('Settings will not persist!')).toBeTruthy();
        expect(screen.getByText('Temporary storage')).toBeTruthy();
    });
});

describe('settings save lifecycle', () => {
    async function startSave() {
        const submit = fixture.enhanceCallbacks.get('?/save');
        if (!submit) throw new Error('Missing save handler');
        const formElement = document.querySelector<HTMLFormElement>('form[action="?/save"]')!;
        const result = await submit({
            action: new URL(formElement.action),
            formData: new FormData(formElement),
            formElement,
            controller: new AbortController(),
            submitter: null,
            cancel: vi.fn(),
        });
        if (!result) throw new Error('Save cancelled');
        await tick();
        return { result, formElement };
    }

    it('locks edits and navigation during save, then retains the draft after failure', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Draft name' },
        });
        const { result, formElement } = await startSave();
        expect(screen.getByLabelText('Site name').closest('fieldset')?.disabled).toBe(true);
        expect(navigate('/admin/users')).toHaveBeenCalledOnce();
        for (const button of screen.getAllByRole('button', { name: 'Discard' })) {
            expect((button as HTMLButtonElement).disabled).toBe(true);
        }
        await result({
            action: new URL(formElement.action),
            formData: new FormData(formElement),
            formElement,
            result: { type: 'failure', status: 400, data: { error: 'Rejected' } },
            update: vi.fn(),
        });
        await tick();
        expect(screen.getByLabelText('Site name').closest('fieldset')?.disabled).toBe(false);
        expect(pendingValues().SITE_NAME).toBe('Draft name');
    });

    it('unlocks the form if applying an action response fails', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Draft name' },
        });
        const { result, formElement } = await startSave();
        await result({
            action: new URL(formElement.action),
            formData: new FormData(formElement),
            formElement,
            result: { type: 'error', status: 500, error: new Error('Failed') },
            update: vi.fn().mockRejectedValue(new Error('Navigation failed')),
        });
        await tick();
        expect(screen.getByLabelText('Site name').closest('fieldset')?.disabled).toBe(false);
        expect(pendingValues().SITE_NAME).toBe('Draft name');
    });
    it('does not reuse an earlier success result when a later save fails', async () => {
        const page = mountPage();
        await page.rerender({ form: { success: true } });
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Keep this draft' },
        });
        const { result, formElement } = await startSave();
        await result({
            action: new URL(formElement.action),
            formData: new FormData(formElement),
            formElement,
            result: { type: 'error', status: 500, error: new Error('Failed') },
            update: vi.fn(),
        });
        await tick();
        expect(pendingValues().SITE_NAME).toBe('Keep this draft');
        expect(screen.getByLabelText('Site name').closest('fieldset')?.disabled).toBe(false);
    });

    it('says so when the save answers with a redirect instead of unlocking silently', async () => {
        mountPage();
        await fireEvent.input(screen.getByLabelText('Site name'), {
            target: { value: 'Draft name' },
        });
        toastError.mockClear();
        const { result, formElement } = await startSave();
        await result({
            action: new URL(formElement.action),
            formData: new FormData(formElement),
            formElement,
            result: { type: 'redirect', status: 303, location: '/login' },
            update: vi.fn(),
        });
        await tick();
        expect(toastError).toHaveBeenCalledOnce();
        expect(pendingValues().SITE_NAME).toBe('Draft name');
        expect(screen.getByLabelText('Site name').closest('fieldset')?.disabled).toBe(false);
    });
});

it('restores category history without losing a draft and marks the current location', async () => {
    mountPage();
    const initial = page.state;
    await fireEvent.input(screen.getByLabelText('Site name'), {
        target: { value: 'Unsaved location draft' },
    });
    await fireEvent.click(screen.getByRole('button', { name: /Playback category/ }));
    const playback = page.state;
    expect(
        screen.getByRole('navigation', { name: 'Current settings location' }).textContent,
    ).toContain('Playback category');
    expect(
        screen.getByRole('button', { name: /Playback category/ }).getAttribute('aria-current'),
    ).toBe('location');
    page.state = initial;
    await tick();
    expect((screen.getByLabelText('Site name') as HTMLInputElement).value).toBe(
        'Unsaved location draft',
    );
    page.state = playback;
    await tick();
    expect(screen.getByLabelText('Player name')).toBeTruthy();
    expect(pendingValues().SITE_NAME).toBe('Unsaved location draft');
});
