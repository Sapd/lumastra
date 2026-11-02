// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Replays the reported sequence end to end, at the popover seam rather than at
 * Avatar's props: user with NO avatar yet opens /settings/account, drops a
 * file, presses Upload.
 *
 * Reported symptom: the drop showed no preview, Upload still showed the old
 * (fallback) image, and only a full page refresh revealed the new avatar.
 *
 * Cause: the initial `getAvatarUrl()` 404s for a user who has never uploaded
 * one, and Avatar latched that failure for the component's lifetime — so both
 * the `blob:` preview AND the post-upload cache-busted URL were swallowed and
 * rendered as the initials/SVG fallback. A refresh "fixed" it only because a
 * fresh mount starts with a clean error state.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadAvatar = vi.fn(async () => ({ success: true }));
const deleteAvatar = vi.fn(async () => ({ error: null }));

vi.mock('$lib/api/user', () => ({
    uploadAvatar: (...args: unknown[]) => uploadAvatar(...(args as [])),
    deleteAvatar: (...args: unknown[]) => deleteAvatar(...(args as [])),
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn() },
}));

import AvatarUploadPopover from './AvatarUploadPopover.svelte';

const OBJECT_URL = 'blob:http://localhost/dropped-avatar';

beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    uploadAvatar.mockClear();
    // happy-dom has no object-URL implementation.
    URL.createObjectURL = vi.fn(() => OBJECT_URL);
    URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function currentImageSrc(container: HTMLElement): string {
    return container.querySelector('img')?.getAttribute('src') ?? '';
}

describe('AvatarUploadPopover preview', () => {
    it('shows the dropped file, and the fresh avatar after upload, for a user with no avatar yet', async () => {
        const { container } = render(AvatarUploadPopover, { props: { username: 'testuser' } });

        // 1. The initial avatar byte request fails for a user with no avatar.
        await waitFor(() =>
            expect(currentImageSrc(container)).toContain(
                '/api/users/testuser/images/avatar?fallback=initials&v=1000&width=',
            ),
        );
        await fireEvent.error(container.querySelector('img')!);
        expect(currentImageSrc(container)).toMatch(/^data:image\/svg/);

        // 2. They drop a PNG onto the zone.
        const file = new File([new Uint8Array([1, 2, 3])], 'face.png', { type: 'image/png' });
        await fireEvent.drop(container.querySelector('.drop-zone')!, {
            dataTransfer: { files: [file] },
        });

        expect(container.textContent).toContain('face.png');
        expect(currentImageSrc(container)).toBe(OBJECT_URL); // the preview, not the fallback

        // 3. They press Upload; it succeeds.
        const upload = [...container.querySelectorAll('button')].find((b) =>
            /upload/i.test(b.textContent ?? ''),
        );
        await fireEvent.click(upload!);

        await waitFor(() => expect(uploadAvatar).toHaveBeenCalledTimes(1));

        // The card must now show the freshly uploaded avatar — a cache-busted
        // request to the avatar route — without needing a page refresh.
        await waitFor(() => {
            const src = currentImageSrc(container);
            expect(src).not.toMatch(/^data:image\/svg/);
            expect(src).toContain('images/avatar');
            expect(src).toContain(
                '/api/users/testuser/images/avatar?fallback=initials&v=1001&width=',
            );
        });
    });
});
