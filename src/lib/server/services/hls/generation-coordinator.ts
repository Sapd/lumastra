// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TranscodeJob } from '../transcoding/types.js';
import type { PlaybackSession } from '../transcoding/types.js';

export interface RetainedGenerationSelection {
    keepIds: Set<string>;
    retireIds: string[];
}

export function createPlaybackSession(
    playSessionId: string,
    now: Date = new Date(),
): PlaybackSession {
    return {
        playSessionId,
        retainedJobIds: [],
        nextGenerationIndex: 1,
        createdAt: now,
        lastAccessedAt: now,
    };
}

export function touchPlaybackSession(
    session: PlaybackSession,
    now: Date = new Date(),
): PlaybackSession {
    session.lastAccessedAt = now;
    return session;
}

export function buildGenerationOutputDir(
    sessionOutputDir: string,
    generationIndex: number,
): string {
    return `${sessionOutputDir}/gen-${generationIndex.toString().padStart(4, '0')}`;
}

export function allocateNextGenerationIndex(session: PlaybackSession): number {
    const index = session.nextGenerationIndex;
    session.nextGenerationIndex += 1;
    return index;
}

export function getMaxRetainedGenerations(maxGenerationsPerSession: number): number {
    return Math.max(0, maxGenerationsPerSession - 1);
}

export function applyRetainedGenerationSelection(
    session: PlaybackSession,
    keepIds: Set<string>,
): void {
    session.retainedJobIds = session.retainedJobIds.filter((jobId) => keepIds.has(jobId));
}

export function selectRetainedGenerationsToKeep(
    retainedJobs: TranscodeJob[],
    retainedJobIdsInSessionOrder: string[],
    options: {
        maxRetained: number;
        anchorSegmentOffset: number;
        preserveJobIds?: string[];
    },
): RetainedGenerationSelection {
    const preserveJobIds = options.preserveJobIds ?? [];
    const retainedById = new Map(retainedJobs.map((job) => [job.id, job]));
    const existingPreserveIds = preserveJobIds.filter((jobId) => retainedById.has(jobId));

    const remainingSlots = Math.max(0, options.maxRetained - existingPreserveIds.length);
    const selected = retainedJobs
        .filter((job) => !existingPreserveIds.includes(job.id))
        .sort((a, b) => {
            const aDistance = Math.abs(a.segmentOffset - options.anchorSegmentOffset);
            const bDistance = Math.abs(b.segmentOffset - options.anchorSegmentOffset);
            if (aDistance !== bDistance) return aDistance - bDistance;
            return b.lastAccessedAt.getTime() - a.lastAccessedAt.getTime();
        })
        .slice(0, remainingSlots);

    const keepIds = new Set([...existingPreserveIds, ...selected.map((job) => job.id)]);
    const retireIds = retainedJobIdsInSessionOrder.filter((jobId) => !keepIds.has(jobId));

    return {
        keepIds,
        retireIds,
    };
}
