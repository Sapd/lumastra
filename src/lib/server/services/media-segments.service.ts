// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    getSegmentsByMediaId,
    toMediaSegments,
    getEpisodeInfo,
} from '$lib/server/database/queries/media-segments.queries.js';
import { getTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import type { MediaSegment } from '$lib/schemas/playback-types.js';
import { isEpisode } from '$lib/server/utils/media-types.js';

const INTRO_ANALYZER_PLUGIN_ID = 'lumastra-intro-analyzer';
const SUPPRESS_FLAG_KEY = 'suppressFirstEpisodeIntro';
const FLAG_TTL_MS = 30 * 60_000; // 30 minutes — segment data is static between re-analyses

/**
 * Read-only facade over cached media segments.
 *
 * Segments are produced asynchronously by the `lumastra-intro-analyzer`
 * external SyncPlugin (chapter probe, black-frame detection, chromaprint
 * fingerprinting) and persisted to the `media_segments` table. This
 * service exposes only the read path — generation is dispatched via
 * `orchestrator.startRun('lumastra-intro-analyzer', …)` from
 * `/api/admin/media/[id]/segments` POST.
 *
 * Note: external SyncPlugins are bridged into the new task registry by
 * the external-plugin adapter in `plugins/runtime/loader.ts` (mirrors
 * the builtin shim at `tasks/builtin/index.ts`). The bridge replaces
 * the legacy `triggerManualSync()` helper that was deleted in the Day
 * 11 queue-layer sweep.
 */
export interface MediaSegmentsService {
    getSegments(mediaId: string, fileId?: string): Promise<MediaSegment[]>;
}

// Module-level cache so all service instances share one TTL window.
// Per-instance caching resets on every request (fresh service creation).
let cachedFlag: boolean | null = null;
let flagCachedAt = 0;
// Request coalescing: concurrent callers share one in-flight DB read.
let inFlight: Promise<boolean> | null = null;

export function createMediaSegmentsService(sql: postgres.Sql): MediaSegmentsService {
    async function readSuppressFlag(): Promise<boolean> {
        const now = Date.now();
        if (cachedFlag !== null && now - flagCachedAt < FLAG_TTL_MS) {
            return cachedFlag;
        }
        if (inFlight) return inFlight;
        const promise = (async () => {
            try {
                const settings = await getTaskSettings(sql, INTRO_ANALYZER_PLUGIN_ID);
                const raw = settings[SUPPRESS_FLAG_KEY];
                const value = raw === true || raw === 'true';
                cachedFlag = value;
                flagCachedAt = Date.now();
                return value;
            } finally {
                inFlight = null;
            }
        })();
        inFlight = promise;
        return promise;
    }

    return {
        async getSegments(mediaId, fileId) {
            const rows = await getSegmentsByMediaId(sql, mediaId, fileId);
            const segments = toMediaSegments(rows);

            const suppress = await readSuppressFlag();
            if (!suppress) {
                return segments;
            }

            const info = await getEpisodeInfo(sql, mediaId);
            if (info !== null && isEpisode(info.media_type) && info.episode_number === 1) {
                return segments.filter((s) => s.type !== 'Intro');
            }

            return segments;
        },
    };
}
