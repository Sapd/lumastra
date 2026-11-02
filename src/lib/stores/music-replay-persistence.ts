// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ReplayItemSchema } from '$lib/schemas/play-session-replay';
import type { MusicReplayItem } from '$lib/api/music';

export const LEGACY_REPLAY_STORAGE_KEY = 'music-playback-replays-v1';
export function musicReplayStorageKey(userId: string | undefined): string | null {
    return userId ? `${LEGACY_REPLAY_STORAGE_KEY}:${userId}` : null;
}
export function boundedMusicReplays(items: unknown[], nowMs = Date.now()): MusicReplayItem[] {
    const cutoff = nowMs - 90 * 86_400_000;
    return items.flatMap((item) => {
        const parsed = ReplayItemSchema.safeParse(item);
        return parsed.success && Date.parse(parsed.data.startedAt) >= cutoff ? [parsed.data] : [];
    }).slice(-500);
}
