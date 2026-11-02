// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The one-time token modal: localized copy, a clipboard failure (plain HTTP
 * origins have no navigator.clipboard) tells the admin to copy by hand, and
 * only the Close button dismisses it — Escape or a backdrop click must not
 * take away the single display of the token (admin/users review 2026-10-07,
 * item 8b).
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import TokenSuccessModal from './TokenSuccessModal.svelte';
import * as m from '$lib/paraglide/messages.js';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('TokenSuccessModal', () => {
    it('renders the localized warning and the token as selectable text', () => {
        render(TokenSuccessModal, { token: 'pat_secret', onClose: vi.fn() });
        expect(screen.getByText(m.settings_tokens_result_warning())).toBeTruthy();
        expect(screen.getByText('pat_secret').className).toContain('select-all');
    });

    it('asks for a manual copy when the clipboard API is unavailable', async () => {
        const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        try {
            render(TokenSuccessModal, { token: 'pat_secret', onClose: vi.fn() });
            await fireEvent.click(screen.getByRole('button', { name: m.admin_conn_copy_token() }));
            await waitFor(() =>
                expect(toasts.error).toHaveBeenCalledWith(m.admin_conn_copy_failed()),
            );
        } finally {
            if (original) Object.defineProperty(navigator, 'clipboard', original);
        }
    });

    it('is not dismissed by Escape or a backdrop click, only by Close', async () => {
        const onClose = vi.fn();
        render(TokenSuccessModal, { token: 'pat_secret', onClose });
        const dialog = screen.getByRole('dialog');

        await fireEvent.keyDown(dialog, { key: 'Escape' });
        await fireEvent.click(dialog);
        expect(onClose).not.toHaveBeenCalled();
        expect(screen.getByText('pat_secret')).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: m.close() }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
