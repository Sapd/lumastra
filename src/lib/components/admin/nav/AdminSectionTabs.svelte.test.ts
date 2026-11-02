// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { ADMIN_NAV } from '$lib/config/admin-nav';
import AdminSectionTabs from './AdminSectionTabs.svelte';

const pageStore = vi.hoisted(() => ({ set: (_: unknown): void => undefined }));
vi.mock('$app/stores', async () => {
    const { writable } = await import('svelte/store');
    const page = writable({ url: new URL('http://localhost/admin/users/sessions') });
    pageStore.set = (value: unknown): void => page.set(value as never);
    return { page };
});
vi.mock('$app/navigation', () => ({ goto: vi.fn(), afterNavigate: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (path: string): string => path }));
afterEach(() => {
    cleanup();
    pageStore.set({ url: new URL('http://localhost/admin/users/sessions') });
});

describe('admin section navigation', () => {
    it('exposes every allowed destination in links and a compact page selector', () => {
        const section = ADMIN_NAV.find((item) => item.id === 'users')!;
        render(AdminSectionTabs, { sections: [section] });
        const select = screen.getByRole('combobox') as HTMLSelectElement;
        expect(select.value).toBe('/admin/users/sessions');
        expect(select.options.length).toBe(section.pages.length);
        expect(screen.getAllByRole('link')).toHaveLength(section.pages.length);
        expect(document.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
        expect(document.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(
            '/admin/users/sessions',
        );
    });

    it('navigates directly from the compact selector without horizontal scrolling', async () => {
        const section = ADMIN_NAV.find((item) => item.id === 'users')!;
        render(AdminSectionTabs, { sections: [section] });
        await fireEvent.change(screen.getByRole('combobox'), { target: { value: '/admin/users' } });
        expect(goto).toHaveBeenCalledWith('/admin/users');
    });

    it('hides on desktop only when the expanded sidebar lists the pages itself', () => {
        const section = ADMIN_NAV.find((item) => item.id === 'users')!;
        render(AdminSectionTabs, { sections: [section], sidebarExpanded: true });
        const tabs = screen.getByRole('navigation', { name: section.title() });
        expect(tabs.classList.contains('sidebar-expanded')).toBe(true);
        cleanup();

        // Mega-menu style, the rail and the drawer widths pass false (the default).
        render(AdminSectionTabs, { sections: [section] });
        expect(
            screen
                .getByRole('navigation', { name: section.title() })
                .classList.contains('sidebar-expanded'),
        ).toBe(false);
    });

    it('keeps Settings own area nav with the expanded sidebar', () => {
        pageStore.set({ url: new URL('http://localhost/admin/settings/media') });
        const section = ADMIN_NAV.find((item) => item.id === 'settings')!;
        render(AdminSectionTabs, { sections: [section], sidebarExpanded: true });
        const settingsNav = screen.getByRole('navigation', { name: 'Settings' });
        expect(settingsNav.classList.contains('sidebar-expanded')).toBe(false);
        expect(settingsNav.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(
            '/admin/settings/media',
        );
    });
});
