// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withWatchEntry, type WatchEntry } from './watch-entry';
import { saveReturnPath } from '$lib/stores/playerNavigation';

import { appPath } from '$lib/shared/api-urls.js';
import { isAudiobook } from '$lib/shared/media-types';

// Returns internal watch URL.
export function getWatchUrl(mediaKey: string): string {
    return `/watch/${mediaKey}`;
}

function mediaKeyNamesAudiobook(mediaKey: string): boolean {
    return mediaKey.split(':').at(-1)?.toLowerCase() === 'audiobook';
}

/**
 * Navigate to watch a media item using the internal player.
 *
 * `startSeconds` opens the player at that position (`?t=`), e.g. a chapter.
 * `entry` marks a linear opening (Continue Watching, Next Up, resume) for the
 * resume handoff (watch-entry.ts); a start time always wins as explicit.
 */
export async function navigateToWatch(
    mediaKey: string,
    mediaType?: string | null,
    opts?: { startSeconds?: number; entry?: WatchEntry },
): Promise<void> {
    if (!mediaKey) return;
    if (isAudiobook(mediaType) || mediaKeyNamesAudiobook(mediaKey)) return;

    saveReturnPath();

    const t = opts?.startSeconds;
    const query = t != null && Number.isFinite(t) && t > 0 ? `?t=${Math.floor(t)}` : '';
    const href = query
        ? `/watch/${mediaKey}${query}`
        : withWatchEntry(`/watch/${mediaKey}`, opts?.entry ?? 'explicit');
    const { goto } = await import('$app/navigation');
    void goto(appPath(href));
}
