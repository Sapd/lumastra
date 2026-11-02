// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, cleanup } from '@testing-library/svelte';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';

// UniversalMediaCard / TrackTitleLine transitively import $env/dynamic/public.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

afterEach(cleanup);

const trackItem: UniversalMediaItem = {
    id: 'track-1',
    itemKey: 'qp:rotation:track-1',
    externalIds: {},
    mediaType: 'track',
    title: 'Harbortime (Ekoglow Remix)',
    image: '/api/image/catalog/track-1?size=poster',
    isAvailable: true,
    canRequest: false,
    artists: [{ id: 'eko', title: 'Ekoglow' }],
};

describe('UniversalMediaCard keydown guard', () => {
    it('does not fire the card action / preventDefault when Enter targets a nested artist-link button', async () => {
        const onclick = vi.fn();
        const { container } = render(UniversalMediaCard, {
            props: { item: trackItem, onclick },
        });

        const artistButton = Array.from(container.querySelectorAll('button')).find(
            (btn) => btn.textContent === 'Ekoglow',
        );
        expect(artistButton).toBeTruthy();

        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        artistButton!.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(false);
        expect(onclick).not.toHaveBeenCalled();
    });

    it('still fires the card action when Enter targets the card wrapper itself', async () => {
        const onclick = vi.fn();
        const { container } = render(UniversalMediaCard, {
            props: { item: trackItem, onclick },
        });

        const wrapper = container.querySelector('[role="button"][tabindex="0"]');
        expect(wrapper).toBeTruthy();

        const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        });
        wrapper!.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(onclick).toHaveBeenCalled();
    });
});
