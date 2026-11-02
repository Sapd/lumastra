// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import AudioOnlyBackdrop from './AudioOnlyBackdrop.svelte';

describe('AudioOnlyBackdrop', () => {
    afterEach(cleanup);

    it('renders title and subtitle', () => {
        const { getByText } = render(AudioOnlyBackdrop, {
            props: { artworkId: 'abc', title: 'The Episode', subtitle: 'S1 E4' },
        });
        expect(getByText('The Episode')).toBeTruthy();
        expect(getByText('S1 E4')).toBeTruthy();
    });

    it('uses the catalog backdrop url', () => {
        const { container } = render(AudioOnlyBackdrop, {
            props: { artworkId: 'abc', title: 'X' },
        });
        expect(container.querySelector('img')?.getAttribute('src')).toContain('abc');
    });
});
