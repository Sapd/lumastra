// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `imageError` latched forever, which broke the avatar-upload preview for
 * exactly the users who need it.
 *
 * AvatarUploadPopover renders `<Avatar src={preview ?? getAvatarUrl(user)}>`.
 * A user who has NOT set an avatar yet 404s that URL on mount, so Avatar's
 * `onerror` fires and sets `imageError = true`. Nothing ever cleared it, so
 * when the user then picked or dropped a file, the fresh `blob:` preview was
 * still rendered as the initials/SVG fallback — the picked image was never
 * shown back to them. Verified on preprod: after a successful file drop the
 * card read "tiny.png" yet the avatar still showed the "DE" fallback.
 *
 * The error state must therefore be scoped to the src that failed, not to the
 * component.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Avatar from './Avatar.svelte';

afterEach(cleanup);

describe('Avatar image error state', () => {
    it('falls back when the current src fails to load', async () => {
        const { container } = render(Avatar, {
            props: { src: '/images/avatar/testuser?v=0', username: 'testuser', alt: 'avatar' },
        });

        const img = container.querySelector('img');
        expect(img?.getAttribute('src')).toContain('/images/avatar/testuser');

        await fireEvent.error(img!);

        expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg/);
    });

    it('retries a NEW src after a previous one failed', async () => {
        const { container, rerender } = render(Avatar, {
            props: { src: '/images/avatar/testuser?v=0', username: 'testuser', alt: 'avatar' },
        });

        await fireEvent.error(container.querySelector('img')!);
        expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg/);

        // The user drops a file; AvatarUploadPopover swaps in an object URL.
        await rerender({
            src: 'blob:http://localhost/preview',
            username: 'testuser',
            alt: 'avatar',
        });

        expect(container.querySelector('img')?.getAttribute('src')).toBe(
            'blob:http://localhost/preview',
        );
    });
});
