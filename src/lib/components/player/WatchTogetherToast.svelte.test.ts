// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import WatchTogetherToast from './WatchTogetherToast.svelte';

afterEach(() => {
    cleanup();
});

describe('Watch Together toast identity', () => {
    it('labels a nameless public author without exposing their account id', () => {
        const { component, getByRole } = render(WatchTogetherToast);
        const userId = '11111111-1111-4111-8111-111111111111';

        flushSync(() => component.showToast('disband', userId, ''));

        const toast = getByRole('status');
        expect(toast.querySelector('.toast-displayName')?.textContent).toBe(m.social_someone());
        expect(toast.textContent).toContain('ended the party');
        expect(toast.textContent).not.toContain(userId);
    });

    it('keeps a public display name when one is present', () => {
        const { component, getByRole } = render(WatchTogetherToast);

        flushSync(() =>
            component.showToast('join', '11111111-1111-4111-8111-111111111111', 'Movie fan'),
        );

        expect(getByRole('status').querySelector('.toast-displayName')?.textContent).toBe(
            'Movie fan',
        );
    });
});
