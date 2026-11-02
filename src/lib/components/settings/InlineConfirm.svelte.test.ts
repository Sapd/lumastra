// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import InlineConfirm from './InlineConfirm.svelte';

describe('InlineConfirm', () => {
    afterEach(() => cleanup());

    test('shows the trigger first, then a confirm/cancel pair', async () => {
        render(InlineConfirm, {
            triggerLabel: 'Revoke',
            confirmLabel: 'Confirm revoke',
            onConfirm: vi.fn(),
        });
        const trigger = screen.getByRole('button', { name: 'Revoke' });
        await fireEvent.click(trigger);
        expect(screen.getByRole('button', { name: 'Confirm revoke' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    test('calls onConfirm only after the second click', async () => {
        const onConfirm = vi.fn();
        render(InlineConfirm, { triggerLabel: 'Delete', confirmLabel: 'Confirm', onConfirm });
        await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    test('cancel returns to the trigger without firing onConfirm', async () => {
        const onConfirm = vi.fn();
        render(InlineConfirm, { triggerLabel: 'Delete', confirmLabel: 'Confirm', onConfirm });
        await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();
    });

    test('focuses Cancel when armed and restores trigger focus on Escape', async () => {
        const onConfirm = vi.fn();
        render(InlineConfirm, { triggerLabel: 'Delete', confirmLabel: 'Confirm', onConfirm });
        await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        expect(document.activeElement).toBe(cancel);
        await fireEvent.keyDown(cancel, { key: 'Escape' });
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete' }));
        expect(onConfirm).not.toHaveBeenCalled();
    });

    test('blocks repeated confirmation until the action resolves', async () => {
        let finish!: () => void;
        const onConfirm = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        );
        render(InlineConfirm, { triggerLabel: 'Delete', confirmLabel: 'Confirm', onConfirm });
        await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        const busy = screen.getByRole('button', { name: /Working/ });
        expect((busy as HTMLButtonElement).disabled).toBe(true);
        await fireEvent.click(busy);
        expect(onConfirm).toHaveBeenCalledTimes(1);
        finish();
        expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy();
    });
});
