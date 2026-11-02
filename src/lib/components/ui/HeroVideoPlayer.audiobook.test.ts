// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The home hero rotates Continue Watching items, and that rail carries
 * audiobooks (`/api/recommendations?type=continue` applies no media-type
 * filter and emits the raw `media_type`). HeroVideoPlayer had no audiobook
 * gate at all, so a book slide mounted MediaPreviewPlayer and opened an ffmpeg
 * transcode session for a file with no video track. The server does not gate it
 * either — `/preview-session` checks access, not media type.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { createPreviewSession } = vi.hoisted(() => ({
    createPreviewSession: vi.fn(async (..._args: unknown[]) => ({
        error: 'not expected',
        data: null,
    })),
}));

// MediaPreviewPlayer's only route to a stream: if a preview is attempted, this
// is what fires.
vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: (...args: unknown[]) => createPreviewSession(...args),
}));
vi.mock('$app/stores', () => ({
    page: readable({
        // The flag the hero's own gate mirrors — on, so nothing else suppresses
        // the request and a "not called" result can only come from the media
        // type.
        data: { features: { videoPreviewSessionEnabled: true }, hover: {} },
        url: new URL('http://localhost/'),
    }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import HeroVideoPlayer from './HeroVideoPlayer.svelte';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const BOOK_UUID = '11111111-2222-4333-8444-555555555555';
const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function continueWatchingItem(overrides: Partial<UniversalMediaItem>): UniversalMediaItem {
    return {
        id: MOVIE_UUID,
        externalIds: { internal: MOVIE_UUID },
        mediaType: 'movie',
        title: 'Haze',
        image: '',
        isAvailable: true,
        hasFiles: true,
        canRequest: false,
        progress: 37,
        ...overrides,
    };
}

/** initializeVideo() runs behind a 100ms "DOM is ready" timeout. */
async function letVideoInitialize(): Promise<void> {
    await new Promise((r) => setTimeout(r, 250));
}

describe('HeroVideoPlayer — audiobook slide', () => {
    beforeEach(() => {
        createPreviewSession.mockClear();
    });

    afterEach(() => {
        cleanup();
    });

    test('opens no preview session for a book', async () => {
        render(HeroVideoPlayer, {
            item: continueWatchingItem({
                id: BOOK_UUID,
                externalIds: { internal: BOOK_UUID },
                mediaType: 'audiobook',
                title: 'Der Sternwind',
            }),
            videoPreviewEnabled: true,
            trailersEnabled: true,
        });
        await letVideoInitialize();

        expect(createPreviewSession).not.toHaveBeenCalled();
    });

    test('still opens one for a Continue Watching movie', async () => {
        render(HeroVideoPlayer, {
            item: continueWatchingItem({}),
            videoPreviewEnabled: true,
        });
        await letVideoInitialize();

        expect(createPreviewSession).toHaveBeenCalled();
    });
});
