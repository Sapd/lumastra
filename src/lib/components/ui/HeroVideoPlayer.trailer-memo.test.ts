// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Prod 2026-09-25: the home hero issued TWO preview-session POSTs for every
 * AI-suggested movie on every carousel loop — a local-trailer probe
 * (`trailerRequired`) that answered `mode: 'none'`, then the snippet. The hero
 * mounts a brand-new HeroVideoPlayer each time a slide re-enters, so the
 * per-instance "no local trailer" verdict was forgotten and the probe re-ran
 * on every pass. A definitive 'none' must be remembered for the page lifetime,
 * like failedVideoItemIds.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

const { createPreviewSession } = vi.hoisted(() => ({
    createPreviewSession: vi.fn(
        (_id: string, opts?: { trailerRequired?: boolean }): Promise<unknown> =>
            opts?.trailerRequired
                ? Promise.resolve({ data: { mode: 'none' }, error: null })
                : // The snippet never answers here: this test is only about the probe.
                  new Promise(() => {}),
    ),
}));

vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: (...args: [string, { trailerRequired?: boolean }]) =>
        createPreviewSession(...args),
}));
vi.mock('$app/stores', () => ({
    page: readable({
        data: { features: { videoPreviewSessionEnabled: true }, hover: {} },
        url: new URL('http://localhost/'),
    }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import HeroVideoPlayer from './HeroVideoPlayer.svelte';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const movie: UniversalMediaItem = {
    id: `hero-ai-${MOVIE_UUID}`,
    externalIds: { internal: MOVIE_UUID },
    mediaType: 'movie',
    title: 'Barbarian',
    image: '',
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
};

/** initializeVideo() runs behind a 100ms "DOM is ready" timeout. */
async function letVideoInitialize(): Promise<void> {
    await new Promise((r) => setTimeout(r, 250));
}

function trailerProbeCalls(): number {
    return createPreviewSession.mock.calls.filter(([, opts]) => opts?.trailerRequired).length;
}

describe('HeroVideoPlayer — local-trailer verdict survives a remount', () => {
    afterEach(() => cleanup());

    test('probes for a local trailer once per page, not on every carousel pass', async () => {
        const first = render(HeroVideoPlayer, {
            item: movie,
            videoPreviewEnabled: true,
            trailersEnabled: true,
        });
        await letVideoInitialize();
        expect(trailerProbeCalls()).toBe(1);
        first.unmount();

        // The slide re-enters on the next loop: a brand-new instance.
        render(HeroVideoPlayer, { item: movie, videoPreviewEnabled: true, trailersEnabled: true });
        await letVideoInitialize();
        expect(trailerProbeCalls()).toBe(1);
    });
});
