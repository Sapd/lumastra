// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';

// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { describe, expect, test, vi, afterEach } from 'vitest';
import type {
    WatchTogetherParty,
    WatchTogetherParticipant,
} from '$lib/schemas/watch-together-core-types';

// The overlay calls goto() on some flows; stub it so render is side-effect free.
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
// Avoid real network when any panel opens.
vi.mock('$lib/api/watch-together', () => ({
    getPublicParties: vi.fn().mockResolvedValue([]),
}));

import WatchTogetherOverlay from './WatchTogetherOverlay.svelte';
import { watchTogether } from '$lib/stores/watchTogether.svelte';

function participant(clientId: string): WatchTogetherParticipant {
    // Same human user (identical userId + displayName) connected from two clients.
    return {
        ...buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'admin', 'internal'),
        joinedAt: 0,
        clientId,
    };
}

function sessionWithDuplicateUser(): WatchTogetherParty {
    return {
        code: 'ABC123',
        host: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'admin', 'internal'),
        hostClientId: 'client-a',
        itemId: 'item-1',
        mediaType: 'movie',
        title: 'Die Laternenbowle',
        currentTime: 0,
        isPlaying: false,
        playbackRate: 1,
        createdAt: 0,
        lastSync: 0,
        visibility: 'unlisted',
        // Two participants, SAME userId/displayName, DISTINCT clientId — the
        // multi-device case. Keying the participant {#each} on userId/displayName
        // produced `each_key_duplicate`; it must key on the unique clientId.
        participants: [participant('client-a'), participant('client-b')],
    };
}

afterEach(() => {
    watchTogether.session = null;
    watchTogether.isHost = false;
});

describe('WatchTogetherOverlay participant list keying', () => {
    test('renders a multi-device party (same user, two clients) without each_key_duplicate', () => {
        watchTogether.session = sessionWithDuplicateUser();
        watchTogether.isHost = true;

        // Pre-fix this render throws `each_key_duplicate` (duplicate key `admin`)
        // because the participants {#each} keyed on userId ?? displayName.
        expect(() =>
            render(WatchTogetherOverlay, {
                props: {
                    itemId: 'item-1',
                    mediaType: 'movie',
                    title: 'Die Laternenbowle',
                    userId: '11111111-1111-4111-8111-111111111111',
                    isOpen: true,
                },
            }),
        ).not.toThrow();
    });
});
