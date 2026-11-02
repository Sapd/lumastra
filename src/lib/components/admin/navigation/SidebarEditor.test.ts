// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import SidebarEditor from './SidebarEditor.svelte';

describe('SidebarEditor', () => {
    test('creates a valid editable link when Add Link is clicked', async () => {
        const user = userEvent.setup();
        const onchange = vi.fn();

        render(SidebarEditor, {
            links: [],
            sections: [],
            onchange,
        });

        await user.click(screen.getByRole('button', { name: 'Add Link' }));

        const label = screen.getByLabelText(/label/i) as HTMLInputElement;
        expect(label.value).toBe('New Link');

        const save = screen.getByRole('button', { name: /^Save$/ });
        expect(save.hasAttribute('disabled')).toBe(false);

        await user.click(save);

        expect(onchange).toHaveBeenLastCalledWith({
            links: [
                expect.objectContaining({
                    label: 'New Link',
                    url: '/',
                    icon: 'home',
                    external: false,
                    displayOrder: 0,
                }),
            ],
            sections: [],
        });
    });

    test('cancel removes the newly created link draft', async () => {
        const user = userEvent.setup();
        const onchange = vi.fn();

        render(SidebarEditor, {
            links: [],
            sections: [],
            onchange,
        });

        await user.click(screen.getByRole('button', { name: 'Add Link' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(onchange).toHaveBeenLastCalledWith({
            links: [],
            sections: [],
        });
    });

    // The name used to be committed on blur, which closed the editor — clicking
    // into a translation field ended the edit before anything could be typed.
    test('a section name and its translations are edited together and saved', async () => {
        const user = userEvent.setup();
        const onchange = vi.fn();
        render(SidebarEditor, {
            links: [],
            sections: [{ id: 'arr', label: 'Arr Suite', displayOrder: 0 }],
            onchange,
        });

        await user.click(screen.getByRole('button', { name: /Edit section name/i }));
        await user.click(screen.getByText('Translations'));
        const german = screen.getByLabelText('Deutsch') as HTMLInputElement;
        await user.type(german, 'Arr-Werkzeuge');
        expect(screen.getByLabelText('Deutsch')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: /^Save$/ }));
        expect(onchange).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sections: [
                    expect.objectContaining({
                        label: 'Arr Suite',
                        labels: { de: 'Arr-Werkzeuge' },
                    }),
                ],
            }),
        );
    });

    test('Cancel leaves the section untouched', async () => {
        const user = userEvent.setup();
        const onchange = vi.fn();
        render(SidebarEditor, {
            links: [],
            sections: [{ id: 'arr', label: 'Arr Suite', displayOrder: 0 }],
            onchange,
        });
        await user.click(screen.getByRole('button', { name: /Edit section name/i }));
        const name = screen.getByRole('textbox', { name: /Edit section name/i });
        await user.clear(name);
        await user.type(name, 'Renamed');
        await user.click(screen.getByRole('button', { name: /^Cancel$/ }));
        expect(onchange).not.toHaveBeenCalled();
        expect(screen.getByText('Arr Suite')).toBeTruthy();
    });

    test('toggling a group keeps the section editor open', async () => {
        const user = userEvent.setup();
        render(SidebarEditor, {
            links: [],
            sections: [{ id: 'arr', label: 'Arr Suite', displayOrder: 0 }],
            availableGroups: ['family'],
            onchange: vi.fn(),
        });
        await user.click(screen.getByRole('button', { name: /Edit section name/i }));
        await user.click(screen.getByRole('button', { name: 'family' }));
        expect(screen.getByRole('textbox', { name: /Edit section name/i })).toBeTruthy();
    });
});
