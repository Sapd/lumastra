// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

type LiveVideo = Pick<HTMLVideoElement, 'currentTime' | 'seekable' | 'readyState' | 'paused'>;
type LiveHls = { readonly liveSyncPosition: number | null };

// Native HLS exposes the last seekable time rather than a live sync position.
// Leave a little room for playback to continue without waiting at the edge.
const NATIVE_LIVE_OFFSET_SECONDS = 3;
const FOREGROUND_SEEK_TOLERANCE_SECONDS = 1;

export function livePosition(
    video: Pick<LiveVideo, 'seekable'>,
    hls?: LiveHls | null,
): number | null {
    const sync = hls?.liveSyncPosition;
    if (sync != null && Number.isFinite(sync) && sync > 0) return sync;

    const last = video.seekable.length - 1;
    if (last < 0) return null;
    const end = video.seekable.end(last);
    if (!Number.isFinite(end)) return null;
    return Math.max(video.seekable.start(last), end - NATIVE_LIVE_OFFSET_SECONDS);
}

export function liveEdgeDistance(position: number | null, currentTime: number): number | null {
    if (position === null || !Number.isFinite(position) || !Number.isFinite(currentTime)) {
        return null;
    }
    return Math.max(0, position - currentTime);
}

/** Catch up without rewinding a viewer who is already at or ahead of the sync position. */
export function catchUpOnVisibility(
    hidden: boolean,
    video: LiveVideo,
    hls?: LiveHls | null,
): boolean {
    if (hidden || video.paused || video.readyState === 0) return false;
    const target = livePosition(video, hls);
    const distance = liveEdgeDistance(target, video.currentTime);
    if (target === null || distance === null || distance <= FOREGROUND_SEEK_TOLERANCE_SECONDS) {
        return false;
    }
    video.currentTime = target;
    return true;
}
