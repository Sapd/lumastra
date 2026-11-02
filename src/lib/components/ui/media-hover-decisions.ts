// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-hover-decisions.ts
 *
 * Pure decision logic for `MediaHoverCard.svelte`: what the hover popup may
 * PLAY inline, and where its play button goes.
 *
 * These decisions used to live inline in `renderPopupContent()`, an imperative
 * ~450-line DOM builder. Nothing there could be tested without mounting the
 * component and faking floating-ui, a portal and a `<video>`, which is why the
 * audiobook fault below shipped: the popup opened a transcode session for a
 * book. (Where the play button GOES is the sibling concern, and lives in
 * `$lib/utils/media-play-target` because card surfaces need the same answer.)
 */

import { isAudiobook } from '$lib/shared/media-types';

// =============================================================================
// Inline preview
// =============================================================================

/** Everything the inline-preview decision depends on. */
export interface HoverPreviewInputs {
    /**
     * The item's RAW media type, straight off the card item. Not a narrowed or
     * mapped value — a narrower would have collapsed `'audiobook'` into
     * something else and made the audiobook branch below dead code.
     */
    mediaType?: string | null;
    /** `trailersEnabled` prop: may this surface autoplay trailers at all? */
    trailersEnabled: boolean;
    /** `videoPreviewEnabled` prop: may this surface autoplay stream previews? */
    videoPreviewEnabled: boolean;
    /** A local file exists AND the item is available (see `getLocalPreviewId`). */
    hasPlayableSource: boolean;
    /** The item carries a directly-playable `nativeStreamUrl`. */
    hasNativeStream: boolean;
    /** A YouTube trailer URL is present AND `trailersEnabled`. */
    hasYouTubeTrailer: boolean;
    /** Continue Watching item (has real progress). */
    isContinueWatchingItem: boolean;
    /** Next Up item (an episode with no progress yet). */
    isNextUpItem: boolean;
    /** This item's local-trailer probe already came back `'none'`. */
    trailerProbeFailed: boolean;
}

/** Which inline video, if any, the popup should attempt. At most one is true. */
export interface HoverPreviewDecision {
    /** Probe for a local trailer file and play it. */
    tryLocalTrailer: boolean;
    /** Open a transcoded preview session on the item's own file/stream. */
    showVideoPreview: boolean;
    /** Embed the YouTube trailer. */
    useYouTubeTrailer: boolean;
}

const NO_PREVIEW: HoverPreviewDecision = {
    tryLocalTrailer: false,
    showVideoPreview: false,
    useYouTubeTrailer: false,
};

/**
 * Can an inline video preview exist for this media type AT ALL?
 *
 * The one gate every preview surface shares. An audiobook has no video track:
 * `POST /preview-session` has nothing to transcode, a YouTube arm would merely
 * trade one wrong video for another, and the still cover is the correct outcome.
 *
 * Takes the RAW `media_items.media_type` / card `mediaType` and compares through
 * {@link isAudiobook}, so all three case conventions (lowercase DB, PascalCase
 * Jellyfin, UPPERCASE legacy) are handled. Do NOT hand it a value some narrowing
 * function has already collapsed — that is how the audiobook arm became dead
 * code the last three times.
 *
 * Surfaces that own their own priority rules (HeroVideoPlayer prefers a movie's
 * trailer over a mid-film snippet, so it cannot share the whole table below)
 * apply THIS to each arm instead of duplicating the reasoning.
 */
export function canPlayInlineVideo(mediaType: string | null | undefined): boolean {
    return !isAudiobook(mediaType);
}

/**
 * Decide which inline video the hover popup may play.
 *
 * Priority: local trailer → stream preview → YouTube trailer → still image.
 *
 * **Audiobooks get no inline video at all** — all three arms, not just the
 * stream preview. A book has no video track: `POST /preview-session` has
 * nothing to transcode, and falling through to the YouTube arm would merely
 * trade one wrong video for another. The still-image path (`stillImageFor()`,
 * which already special-cases audiobook → `'poster'`) is the correct outcome.
 * The gate reads the RAW `mediaType` through {@link isAudiobook} so all three
 * case conventions (lowercase DB, PascalCase Jellyfin, UPPERCASE legacy) are
 * handled.
 */
export function decideHoverPreview(inputs: HoverPreviewInputs): HoverPreviewDecision {
    if (!canPlayInlineVideo(inputs.mediaType)) return NO_PREVIEW;

    // Local trailer probe: tried first, ahead of the YouTube/snippet priority
    // below. Continue Watching / Next Up items keep their local resume-preview
    // instead (a trailer would restart from 0, defeating the point of
    // "continue"). A 'none' answer falls through to YouTube-or-snippet;
    // `trailerProbeFailed` remembers that so we don't re-probe the same item.
    const tryLocalTrailer =
        inputs.trailersEnabled &&
        inputs.hasPlayableSource &&
        !inputs.isContinueWatchingItem &&
        !inputs.isNextUpItem &&
        !inputs.trailerProbeFailed;

    // Stream preview: feature enabled AND a playable source AND (Continue
    // Watching / Next Up OR no YouTube trailer OR a native stream).
    const showVideoPreview =
        inputs.videoPreviewEnabled &&
        (inputs.hasPlayableSource || inputs.hasNativeStream) &&
        (inputs.isContinueWatchingItem ||
            inputs.isNextUpItem ||
            !inputs.hasYouTubeTrailer ||
            inputs.hasNativeStream);

    return {
        tryLocalTrailer,
        showVideoPreview,
        useYouTubeTrailer: !tryLocalTrailer && !showVideoPreview && inputs.hasYouTubeTrailer,
    };
}

// =============================================================================
// Fallback content (after a trailer / YouTube attempt has already failed)
// =============================================================================

/** What the popup shows once an earlier video attempt is out of the picture. */
export type HoverFallbackContent = 'youtube' | 'snippet' | 'image';

/** Inputs for {@link decideFallbackContent}. */
export interface HoverFallbackInputs {
    /** RAW media type off the item — see {@link HoverPreviewInputs.mediaType}. */
    mediaType?: string | null;
    /**
     * A YouTube video id was parsed out of `trailerUrl` AND the caller has not
     * already tried and failed that trailer. A `trailerUrl` that does not parse
     * (malformed / unsupported host) does not count.
     */
    hasUsableYouTubeId: boolean;
    /**
     * A trailer URL is present AND `trailersEnabled` — the real
     * trailer-PRESENCE signal, deliberately unaffected by "already tried it".
     * A caller that failed the YouTube trailer must not have that read as
     * "there was never a trailer", which would widen snippet eligibility for
     * ordinary items whose only remaining fallback is the still image.
     */
    hasYouTubeTrailer: boolean;
    videoPreviewEnabled: boolean;
    hasPlayableSource: boolean;
    hasNativeStream: boolean;
    isContinueWatchingItem: boolean;
    isNextUpItem: boolean;
}

/**
 * The "YouTube trailer → local snippet → still image" priority, used once the
 * local-trailer probe is out of the picture (it failed, or it was never tried
 * for this item — e.g. Continue Watching / Next Up).
 *
 * This is NOT the same priority as {@link decideHoverPreview}: here a usable
 * YouTube trailer wins outright, whereas the initial decision prefers a
 * resume-snippet for Continue Watching / Next Up items. The two live side by
 * side in this module precisely because they are near-copies that must not
 * drift again — in particular they share the audiobook gate below, which is
 * what keeps the fallback path from re-introducing a video for a book.
 */
export function decideFallbackContent(inputs: HoverFallbackInputs): HoverFallbackContent {
    if (!canPlayInlineVideo(inputs.mediaType)) return 'image';

    if (inputs.hasUsableYouTubeId) return 'youtube';

    const canShowSnippet =
        inputs.videoPreviewEnabled &&
        (inputs.hasPlayableSource || inputs.hasNativeStream) &&
        (inputs.isContinueWatchingItem ||
            inputs.isNextUpItem ||
            !inputs.hasYouTubeTrailer ||
            inputs.hasNativeStream);

    return canShowSnippet ? 'snippet' : 'image';
}
