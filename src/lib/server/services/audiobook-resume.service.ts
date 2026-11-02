// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { AudiobookMediaProgress, AudiobookshelfClient } from '../audiobookshelf.js';
import { getState } from '../database/queries/user-media-state.queries.js';

interface ReadAudiobookResumeInput {
    sql: postgres.Sql;
    userId: UserId;
    mediaId: string;
    absItemId: string;
    apiKey: string;
    client: Pick<AudiobookshelfClient, 'getMeAs'>;
    readProgress?: () => Promise<AudiobookMediaProgress | undefined>;
    fallbackPositionMs: number;
    signal?: AbortSignal;
}

interface AudiobookResume {
    positionMs: number;
    localIsNewest: boolean;
    isFinished: boolean;
}

/** Timestamp arbitration also permits an intentional newer seek backwards. */
export async function readAudiobookResume(
    input: ReadAudiobookResumeInput,
): Promise<AudiobookResume> {
    // Both progress endpoints include completed books. A failed read is not
    // evidence of absent progress. Writers must retain their queue and retry.
    const upstream = input.readProgress
        ? await input.readProgress()
        : await readAudiobookProgress(input.client, input.apiKey, input.absItemId, input.signal);
    // Re-read after network I/O so a newer local report can replace the batch's
    // snapshot while ABS is responding.
    const local = await getState.one(input.sql, { userId: input.userId, mediaId: input.mediaId });
    const localAt = local?.last_event_at ? new Date(local.last_event_at).getTime() : 0;
    const localIsNewest =
        !!local && (!upstream || localAt + ABS_TIMESTAMP_TOLERANCE_MS >= upstream.lastUpdate);
    const upstreamMs =
        upstream && Number.isFinite(upstream.currentTime)
            ? Math.max(0, Math.round(upstream.currentTime * 1000))
            : input.fallbackPositionMs;
    return {
        positionMs: localIsNewest ? local.resume_position_ms : upstreamMs,
        localIsNewest,
        isFinished: localIsNewest ? local.is_watched : upstream?.isFinished === true,
    };
}

/** Allow sub-second differences between device and ABS clocks. */
export const ABS_TIMESTAMP_TOLERANCE_MS = 500;

/** Complete book progress, including finished rows. A failed read must throw. */
export async function readAudiobookProgress(
    client: Pick<AudiobookshelfClient, 'getMeAs'>,
    apiKey: string,
    itemId: string,
    signal?: AbortSignal,
): Promise<AudiobookMediaProgress | undefined> {
    const me = await client.getMeAs(apiKey, signal);
    if (!me) throw new Error('AudiobookShelf returned no current-user progress');
    return me.mediaProgress.find((p) => p.libraryItemId === itemId && !p.episodeId);
}

/** The snapshot and failures are shared only for this batch, never across runs. */
export function batchAudiobookProgressReader(
    client: Pick<AudiobookshelfClient, 'getMeAs'>,
): Pick<AudiobookshelfClient, 'getMeAs'> {
    const users = new Map<string, ReturnType<AudiobookshelfClient['getMeAs']>>();
    return {
        getMeAs(apiKey, signal): ReturnType<AudiobookshelfClient['getMeAs']> {
            let pending = users.get(apiKey);
            if (!pending) {
                pending = client.getMeAs(apiKey, signal);
                users.set(apiKey, pending);
            }
            return pending;
        },
    };
}
