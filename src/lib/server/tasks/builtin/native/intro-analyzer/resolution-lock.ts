// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export {
    acquireExclusiveMediaSegmentWriteGate,
    acquireMediaSegmentResolutionLock,
    acquireMediaSegmentResolutionLocks,
    bumpGlobalMediaSegmentAnalysisGeneration,
    bumpMediaSegmentAnalysisGeneration,
    getGlobalMediaSegmentAnalysisGeneration,
} from '$lib/server/database/media-segment-resolution-lock.js';
