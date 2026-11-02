// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { TranscodeJob } from '../transcoding/types.js';

/**
 * A job running in demux copy-video GOP mode (gop-grid.ts): decided at start,
 * carried through every generation. Dependency-free so low-level modules
 * (process-runner) can ask without importing the transcode service.
 */
export function isGopModeJob(job: Pick<TranscodeJob, 'config' | 'keyframeData'>): boolean {
    return job.config?.gopSegments === true && (job.keyframeData?.length ?? 0) > 0;
}
