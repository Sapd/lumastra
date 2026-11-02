// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAudiobookActivityFeed, openMediaModal } = vi.hoisted(() => ({
    getAudiobookActivityFeed: vi.fn(),
    openMediaModal: vi.fn(),
}));

vi.mock('$lib/api/for-you.js', () => ({ getAudiobookActivityFeed }));
vi.mock('$lib/utils/modal-utils.js', () => ({ openMediaModal }));

import AudiobookActivityRail from './AudiobookActivityRail.svelte';

const section = {
    type: 'audiobook-activity' as const,
    id: 'audiobook-activity' as const,
    title: 'Listening in your circle',
    items: [
        {
            author: {
                userId: '00000000-0000-4000-8000-000000000001',
                displayName: 'Anna',
                images: { primary: { href: '/avatar', revision: '0', source: 'self' as const } },
            },
            media: {
                id: '00000000-0000-4000-8000-000000000002',
                type: 'audiobook' as const,
                title: 'The Long Book',
                catalogId: '00000000-0000-4000-8000-000000000002',
                ids: {},
                audiobook: { authors: [], narrators: [], series: null },
                images: { primary: { href: '/poster', source: 'self' as const, revision: '1' } },
            },
            kind: 'listened' as const,
            listenedMinutes: 120,
            occurredOn: new Date().toISOString().slice(0, 10),
            approximate: false,
        },
    ],
};

describe('AudiobookActivityRail', () => {
    beforeEach(() => {
        getAudiobookActivityFeed.mockResolvedValue({
            data: { sections: [section] },
            error: null,
        });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('renders one coarse person/book activity and opens the book', async () => {
        render(AudiobookActivityRail);

        const card = await screen.findByRole('button', { name: 'Anna: The Long Book' });
        expect(screen.getByText('~2 hr this week · last today')).toBeTruthy();

        await fireEvent.click(card);
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'The Long Book',
                mediaType: 'audiobook',
                externalIds: { internal: section.items[0].media.id },
            }),
            '/poster',
        );
    });

    it('renders nothing when the feed omits the optional section', async () => {
        getAudiobookActivityFeed.mockResolvedValue({ data: { sections: [] }, error: null });
        const { container } = render(AudiobookActivityRail);

        await vi.waitFor(() => expect(getAudiobookActivityFeed).toHaveBeenCalled());
        expect(container.querySelector('section')).toBeNull();
    });
});

describe('AudiobookActivityRail — server-supplied section', () => {
    /**
     * `/audiobooks` builds its own section, deliberately WITHOUT the
     * viewer-listening gate /feed applies. Refetching would silently replace it
     * with the gated answer and hide the rail from exactly the newcomers it is
     * meant for.
     */
    it('renders the provided section without calling the feed', async () => {
        render(AudiobookActivityRail, { props: { section } });

        expect(await screen.findByText('The Long Book')).toBeTruthy();
        expect(getAudiobookActivityFeed).not.toHaveBeenCalled();
    });

    it('fetches for itself when no section is provided', async () => {
        getAudiobookActivityFeed.mockResolvedValue({
            data: { sections: [section] },
            error: null,
        });

        render(AudiobookActivityRail);

        expect(await screen.findByText('The Long Book')).toBeTruthy();
        expect(getAudiobookActivityFeed).toHaveBeenCalled();
    });
});
