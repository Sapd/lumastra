// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import QualitySelector from './QualitySelector.svelte';
import { playerStore } from './playerStore.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';

afterEach(() => {
    cleanup();
    playerStore.isLive = false;
    watchTogether.session = null;
});

describe('audio-only rung', () => {
    it('appears for VOD', () => {
        playerStore.isLive = false;
        const { getByText } = render(QualitySelector, { props: { autoQualityEnabled: true } });
        expect(getByText('Audio only')).toBeTruthy();
    });

    it('is hidden for live streams', () => {
        playerStore.isLive = true;
        const { queryByText } = render(QualitySelector, { props: { autoQualityEnabled: true } });
        expect(queryByText('Audio only')).toBeNull();
    });

    it('is hidden while in a watch party', () => {
        playerStore.isLive = false;
        watchTogether.session = { id: 'party-1' } as never;
        const { queryByText } = render(QualitySelector, { props: { autoQualityEnabled: true } });
        expect(queryByText('Audio only')).toBeNull();
    });
});
