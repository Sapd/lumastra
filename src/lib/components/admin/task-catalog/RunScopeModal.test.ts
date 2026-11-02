// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * One of the two options here DELETES a library's worth of results before it
 * starts. These pin the guards that stand between a click and that: force is
 * absent unless the task can actually wipe, and it cannot be confirmed until
 * the operator acknowledges what it does.
 */

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import RunScopeModal from './RunScopeModal.svelte';

vi.mock('$lib/stores/modal.store', () => ({
    modals: { close: vi.fn().mockResolvedValue(undefined) },
}));

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RunScopeModal', () => {
    test('hides the destructive option for a task that cannot wipe', () => {
        render(RunScopeModal, { allowForce: false, onConfirm: vi.fn() });

        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        // Offering force here would promise a rebuild the drain silently
        // downgrades to an ordinary manual run.
        expect(radios.map((r) => r.value)).toEqual(['manual']);
    });

    test('defaults to the non-destructive option', () => {
        render(RunScopeModal, { allowForce: true, onConfirm: vi.fn() });

        const radios = screen.getAllByRole('radio') as HTMLInputElement[];
        expect(radios.map((r) => r.value)).toEqual(['manual', 'force']);
        expect(radios[0].checked).toBe(true);
    });

    test('blocks the confirm until force is acknowledged', async () => {
        const onConfirm = vi.fn();
        render(RunScopeModal, { allowForce: true, onConfirm });

        const force = screen
            .getAllByRole('radio')
            .find((r) => (r as HTMLInputElement).value === 'force')!;
        force.click();
        await tick();

        const confirm = screen.getByRole('button', {
            name: /start run|lauf starten/i,
        }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);

        // Clicking anyway must not slip past the gate.
        confirm.click();
        await tick();
        expect(onConfirm).not.toHaveBeenCalled();

        screen.getByRole('checkbox').click();
        await tick();
        expect(confirm.disabled).toBe(false);

        confirm.click();
        await tick();
        expect(onConfirm).toHaveBeenCalledWith('force');
    });

    test('re-arms the acknowledgement when the operator leaves force and returns', async () => {
        const onConfirm = vi.fn();
        render(RunScopeModal, { allowForce: true, onConfirm });

        const [manual, force] = screen.getAllByRole('radio');
        force.click();
        await tick();
        screen.getByRole('checkbox').click();
        await tick();

        // Abandon force with the box still ticked, then come back to it.
        manual.click();
        await tick();
        force.click();
        await tick();

        const confirm = screen.getByRole('button', {
            name: /start run|lauf starten/i,
        }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    });

    test('the plain path starts a manual run without any acknowledgement', async () => {
        const onConfirm = vi.fn();
        render(RunScopeModal, { allowForce: true, onConfirm });

        screen.getByRole('button', { name: /start run|lauf starten/i }).click();
        await tick();

        expect(onConfirm).toHaveBeenCalledWith('manual');
    });
});
