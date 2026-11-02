// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The EPG column of Channel Management.
 *
 * A guide match is not always an EPG channel id: a bare playlist (no tvg-id)
 * is matched by name, which stores a confidence and signals but leaves
 * epg_channel_id empty. Keying "matched" on the id alone showed every channel
 * of such a lineup (12k on prod) as unmatched although their guide worked.
 */

import type { AdminChannel } from '$lib/schemas/livetv.js';

/** Below this the review screen calls a match low confidence (epg/review.ts). */
const CONFIDENT = 0.8;

export type ChannelEpgStatus =
    /** Guide matched with confidence, or linked by EPG channel id. */
    | 'matched'
    /** Guide taken over from another feed of the same station (backup group). */
    | 'shared'
    /** Matched, but worth checking in EPG Matches. */
    | 'low'
    | 'unmatched';

export function channelEpgStatus(
    channel: Pick<AdminChannel, 'epgChannelId' | 'epgMatchConfidence' | 'epgMatchSignals'>,
): ChannelEpgStatus {
    const confidence = channel.epgMatchConfidence;
    if (confidence === undefined) return channel.epgChannelId ? 'matched' : 'unmatched';
    if (confidence < CONFIDENT) return 'low';
    return channel.epgMatchSignals?.includes('backup_propagation') ? 'shared' : 'matched';
}
