// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { initMediaSession } from '$lib/utils/media-session';
import type { MediaSessionActions, TrackMetadata } from './types';

/**
 * Shared MediaSession handler registration — extracted from the identical
 * private `registerMediaSessionHandlers()` implementations in
 * WebAudioBackend, SafariAudioBackend, and PlainAudioBackend.
 *
 * Registers play/pause/next/prev/seek/stop action handlers on
 * `navigator.mediaSession` and sets the lock-screen metadata. For live-radio
 * tracks (`metadata.isRadio === true`) the prev/next/seekto actions are
 * omitted so iOS does not render a scrubber or skip buttons.
 *
 * @param metadata  Current track metadata, or null to show the fallback
 *                  "Lumastra Music" title (used right after init before a
 *                  track is loaded).
 * @param actions   MediaSession action callbacks — typically
 *                  `storedMediaSessionActions` kept by each backend.
 *                  When null this is a no-op (guards the pre-init call
 *                  site in each backend).
 */
export function registerMediaSessionHandlers(
    metadata: TrackMetadata | null,
    actions: MediaSessionActions | null,
): void {
    if (!actions) return;

    const mediaMetadata = metadata
        ? {
              title: metadata.title,
              artist: metadata.artist,
              album: metadata.album,
              artwork: metadata.artworkUrl,
          }
        : { title: 'Lumastra Music', artist: '' };

    // Keep previous/next track controls, allow the scrubber seek action,
    // but do not advertise seekforward/seekbackward 10-second buttons.
    // For live radio: drop prev/next and seekto entirely — no queue,
    // no positional seeking on a live stream.
    const isRadio = metadata?.isRadio === true;
    initMediaSession(
        mediaMetadata,
        {
            onPlay: actions.onPlay,
            onPause: actions.onPause,
            onNextTrack: isRadio ? undefined : actions.onNextTrack,
            onPreviousTrack: isRadio ? undefined : actions.onPreviousTrack,
            onSeekTo: isRadio ? undefined : actions.onSeekTo,
            onStop: actions.onStop,
        },
        { trackControlsOnly: true, seekToWithTrackControls: !isRadio },
    );
}
