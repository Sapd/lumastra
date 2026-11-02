// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hovering an audiobook in Continue Watching opened a video preview — there is no
 * video in a book. The branch table now lives in one pure module so these cases
 * are provable without mounting the popup. (The play-button destination is the
 * sibling fault; see `$lib/utils/media-play-target.test.ts`.)
 *
 * The case-convention cases are not decoration: `media_items.media_type` stores
 * `'audiobook'`, Jellyfin says `'AudioBook'`, and legacy/tvOS clients send
 * `'AUDIOBOOK'`. A bare `=== 'audiobook'` would pass the first case and ship the
 * bug for the other two.
 */

import { describe, it, expect } from 'vitest';
import {
    decideFallbackContent,
    decideHoverPreview,
    type HoverFallbackInputs,
    type HoverPreviewInputs,
} from './media-hover-decisions';

/**
 * A Continue Watching card as `audiobookProgressToEntry()` builds it: available,
 * has files, real progress. That progress is what made `isContinueWatchingItem`
 * true and turned the stream preview on.
 */
function continueWatchingInputs(overrides: Partial<HoverPreviewInputs> = {}): HoverPreviewInputs {
    return {
        mediaType: 'audiobook',
        trailersEnabled: true,
        videoPreviewEnabled: true,
        hasPlayableSource: true,
        hasNativeStream: false,
        hasYouTubeTrailer: false,
        isContinueWatchingItem: true,
        isNextUpItem: false,
        trailerProbeFailed: false,
        ...overrides,
    };
}

function fallbackInputs(overrides: Partial<HoverFallbackInputs> = {}): HoverFallbackInputs {
    return {
        mediaType: 'audiobook',
        hasUsableYouTubeId: false,
        hasYouTubeTrailer: false,
        videoPreviewEnabled: true,
        hasPlayableSource: true,
        hasNativeStream: false,
        isContinueWatchingItem: true,
        isNextUpItem: false,
        ...overrides,
    };
}

describe('decideHoverPreview — audiobooks get no inline video', () => {
    // Every case convention the codebase carries. A comparator, not `===`.
    for (const mediaType of ['audiobook', 'AudioBook', 'AUDIOBOOK', 'Audiobook']) {
        it(`plays nothing for mediaType='${mediaType}'`, () => {
            expect(decideHoverPreview(continueWatchingInputs({ mediaType }))).toEqual({
                tryLocalTrailer: false,
                showVideoPreview: false,
                useYouTubeTrailer: false,
            });
        });
    }

    it('suppresses the YouTube arm too — not just the stream preview', () => {
        // Gating only the preview would have swapped one wrong video for
        // another: the YouTube arm fires exactly when the other two do not.
        const decision = decideHoverPreview(
            continueWatchingInputs({ hasYouTubeTrailer: true, videoPreviewEnabled: false }),
        );
        expect(decision.useYouTubeTrailer).toBe(false);
    });

    it('suppresses the local-trailer probe for a book with no progress', () => {
        // A book outside Continue Watching takes the trailer-probe arm instead,
        // which POSTs a preview session just the same.
        const decision = decideHoverPreview(
            continueWatchingInputs({ isContinueWatchingItem: false }),
        );
        expect(decision.tryLocalTrailer).toBe(false);
        expect(decision.showVideoPreview).toBe(false);
    });
});

describe('decideHoverPreview — video items keep their previews', () => {
    it('still shows the resume preview for a Continue Watching movie', () => {
        expect(decideHoverPreview(continueWatchingInputs({ mediaType: 'movie' }))).toEqual({
            tryLocalTrailer: false,
            showVideoPreview: true,
            useYouTubeTrailer: false,
        });
    });

    it('still probes the local trailer for a fresh movie', () => {
        const decision = decideHoverPreview(
            continueWatchingInputs({ mediaType: 'movie', isContinueWatchingItem: false }),
        );
        expect(decision.tryLocalTrailer).toBe(true);
    });

    it('still falls back to YouTube when neither local arm applies', () => {
        const decision = decideHoverPreview(
            continueWatchingInputs({
                mediaType: 'movie',
                trailersEnabled: true,
                hasYouTubeTrailer: true,
                videoPreviewEnabled: false,
                hasPlayableSource: false,
                isContinueWatchingItem: false,
            }),
        );
        expect(decision).toEqual({
            tryLocalTrailer: false,
            showVideoPreview: false,
            useYouTubeTrailer: true,
        });
    });

    it('keeps the episode Next Up preview', () => {
        const decision = decideHoverPreview(
            continueWatchingInputs({
                mediaType: 'episode',
                isContinueWatchingItem: false,
                isNextUpItem: true,
            }),
        );
        expect(decision.showVideoPreview).toBe(true);
    });

    it('respects the disabled feature flags', () => {
        expect(
            decideHoverPreview(
                continueWatchingInputs({
                    mediaType: 'movie',
                    trailersEnabled: false,
                    videoPreviewEnabled: false,
                }),
            ),
        ).toEqual({
            tryLocalTrailer: false,
            showVideoPreview: false,
            useYouTubeTrailer: false,
        });
    });
});

describe('decideFallbackContent — the second, near-duplicate priority table', () => {
    it('answers image for an audiobook even with a usable YouTube id', () => {
        expect(
            decideFallbackContent(
                fallbackInputs({ hasUsableYouTubeId: true, hasYouTubeTrailer: true }),
            ),
        ).toBe('image');
    });

    it('answers image for an audiobook that would otherwise get a snippet', () => {
        expect(decideFallbackContent(fallbackInputs())).toBe('image');
    });

    it('still prefers YouTube for a video item', () => {
        expect(
            decideFallbackContent(
                fallbackInputs({
                    mediaType: 'movie',
                    hasUsableYouTubeId: true,
                    hasYouTubeTrailer: true,
                }),
            ),
        ).toBe('youtube');
    });

    it('still answers snippet for a Continue Watching video item', () => {
        expect(decideFallbackContent(fallbackInputs({ mediaType: 'movie' }))).toBe('snippet');
    });

    it('still answers image when nothing is eligible', () => {
        expect(
            decideFallbackContent(
                fallbackInputs({
                    mediaType: 'movie',
                    videoPreviewEnabled: false,
                    hasPlayableSource: false,
                }),
            ),
        ).toBe('image');
    });
});
