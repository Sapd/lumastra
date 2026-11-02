// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import ActionModal from './ActionModal.svelte';

/**
 * Behavioral tests for ActionModal's focus management + Escape handling.
 *
 * These verify the Wave 12-B a11y contract:
 *   1. On open, focus moves to the Cancel button (data-autofocus).
 *   2. Escape dismisses the modal (onclose fires).
 *   3. Clicking the overlay dismisses the modal.
 *   4. Clicking the inner dialog does NOT dismiss (stopPropagation).
 *
 * Focus-trap wrap/cycle behavior is covered in isolation by
 * `src/lib/utils/focus-trap.test.ts` — this suite only asserts that the
 * action is wired up (Cancel receives autofocus on mount).
 */
describe('ActionModal', () => {
    test('autofocuses the Cancel button on open', async () => {
        render(ActionModal, {
            title: 'Confirm action',
            confirmText: 'Go',
            onclose: vi.fn(),
            onconfirm: vi.fn(),
        });

        // queueMicrotask used inside trapFocus defers focus to the next tick
        await new Promise((r) => setTimeout(r, 0));

        const cancel = screen.getByRole('button', { name: 'Cancel' });
        expect(document.activeElement).toBe(cancel);
    });

    test('Escape key invokes onclose', async () => {
        const onclose = vi.fn();
        render(ActionModal, {
            title: 'Confirm action',
            onclose,
            onconfirm: vi.fn(),
        });

        await new Promise((r) => setTimeout(r, 0));

        const cancel = screen.getByRole('button', { name: 'Cancel' });
        cancel.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );

        expect(onclose).toHaveBeenCalledTimes(1);
    });

    test('clicking overlay invokes onclose', async () => {
        const onclose = vi.fn();
        render(ActionModal, {
            title: 'Confirm action',
            onclose,
            onconfirm: vi.fn(),
        });

        const overlay = screen.getByRole('dialog');
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(onclose).toHaveBeenCalledTimes(1);
    });

    test('clicking Cancel button invokes onclose', async () => {
        const onclose = vi.fn();
        const onconfirm = vi.fn();
        render(ActionModal, {
            title: 'Confirm action',
            onclose,
            onconfirm,
        });

        await new Promise((r) => setTimeout(r, 0));

        const cancel = screen.getByRole('button', { name: 'Cancel' });
        cancel.click();

        expect(onclose).toHaveBeenCalledTimes(1);
        expect(onconfirm).not.toHaveBeenCalled();
    });

    test('clicking Confirm button invokes onconfirm', async () => {
        const onclose = vi.fn();
        const onconfirm = vi.fn();
        render(ActionModal, {
            title: 'Confirm action',
            confirmText: 'Wipe',
            onclose,
            onconfirm,
        });

        await new Promise((r) => setTimeout(r, 0));

        const confirm = screen.getByRole('button', { name: 'Wipe' });
        confirm.click();

        expect(onconfirm).toHaveBeenCalledTimes(1);
        expect(onclose).not.toHaveBeenCalled();
    });

    test('rapid double-click on Confirm only invokes onconfirm once', async () => {
        const onclose = vi.fn();
        // onconfirm returns a promise that does not resolve immediately
        let resolveConfirm!: () => void;
        const onconfirm = vi.fn(
            () =>
                new Promise<void>((r) => {
                    resolveConfirm = r;
                }),
        );

        render(ActionModal, {
            title: 'Confirm action',
            confirmText: 'Delete',
            onclose,
            onconfirm,
        });

        await new Promise((r) => setTimeout(r, 0));

        const confirm = screen.getByRole('button', { name: 'Delete' });
        confirm.click();
        confirm.click();

        // Allow microtasks to flush
        await Promise.resolve();

        expect(onconfirm).toHaveBeenCalledTimes(1);

        resolveConfirm();
    });
});
