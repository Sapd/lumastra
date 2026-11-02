// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A server-side 413 (the route's 2 MB cap, adapter-node's BODY_SIZE_LIMIT, or
 * a reverse proxy's own body limit answering with an HTML page) must read as
 * "File too large" in the user's language — not as the raw server text or a
 * bare "Request Entity Too Large".
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';

const uploadAvatar = vi.fn();
const toastError = vi.fn();

vi.mock('$lib/api/user', () => ({
    uploadAvatar: (...args: unknown[]) => uploadAvatar(...args),
    deleteAvatar: vi.fn(async () => ({ error: null })),
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: (...args: unknown[]) => toastError(...args) },
}));

import AvatarUploadPopover from './AvatarUploadPopover.svelte';

beforeEach(() => {
    uploadAvatar.mockReset();
    toastError.mockReset();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/x');
    URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

async function dropAndUpload(container: HTMLElement): Promise<void> {
    const file = new File([new Uint8Array([1, 2, 3])], 'face.jpg', { type: 'image/jpeg' });
    await fireEvent.drop(container.querySelector('.drop-zone')!, {
        dataTransfer: { files: [file] },
    });
    const upload = [...container.querySelectorAll('button')].find((b) =>
        /upload/i.test(b.textContent ?? ''),
    );
    await fireEvent.click(upload!);
}

describe('AvatarUploadPopover — upload refused as too large', () => {
    it('shows the localized too-large message for a 413', async () => {
        uploadAvatar.mockResolvedValue({
            success: false,
            status: 413,
            error: 'Request Entity Too Large',
        });
        const { container } = render(AvatarUploadPopover, { props: { username: 'testuser' } });

        await dropAndUpload(container);

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(m.toast_avatar_file_too_large()),
        );
    });

    it('keeps the server message for other failures', async () => {
        uploadAvatar.mockResolvedValue({
            success: false,
            status: 400,
            error: 'Invalid image format. Allowed: JPEG, PNG, WebP, GIF',
        });
        const { container } = render(AvatarUploadPopover, { props: { username: 'testuser' } });

        await dropAndUpload(container);

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(
                'Invalid image format. Allowed: JPEG, PNG, WebP, GIF',
            ),
        );
    });
});
