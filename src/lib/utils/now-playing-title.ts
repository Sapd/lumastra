// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicTrack } from '$lib/schemas/music';
import type { RadioNowPlaying } from '$lib/schemas/radio';

/** Placeholder the store parks on tracks whose artist hasn't resolved yet. */
const UNKNOWN_ARTIST = 'Unknown Artist';

/** Same play indicator the video player puts in the tab title. */
const PLAYING_INDICATOR = '▶';

export interface NowPlayingTitleInput {
    track: MusicTrack | null;
    isPlaying: boolean;
    /** Live ICY metadata; only consulted for radio tracks. */
    radioNowPlaying?: RadioNowPlaying | null;
}

/**
 * The music player's tab title: `▶ Song · Artist`, mirroring the mini player's
 * own now-playing line.
 *
 * Returns null whenever nothing is playing, which hands the tab title back to
 * the page — a paused player shouldn't outrank the page the user is reading.
 */
export function formatNowPlayingTitle({
    track,
    isPlaying,
    radioNowPlaying,
}: NowPlayingTitleInput): string | null {
    if (!isPlaying || !track) return null;

    // Radio prefers the song on air over the station name: the station is why
    // the tab is open, the song is what actually changes. Falls back to the
    // station whenever the stream carries no metadata.
    const live = track.isRadio ? radioNowPlaying?.track : undefined;
    const onAir = live?.title?.trim();

    const title = (onAir || track.title || '').trim();
    if (!title) return null;

    const artist = (onAir ? live?.artist : track.artists.map((a) => a.title).join(', '))?.trim() ?? '';
    const suffix = artist && artist !== UNKNOWN_ARTIST ? ` · ${artist}` : '';

    return `${PLAYING_INDICATOR} ${title}${suffix}`;
}
