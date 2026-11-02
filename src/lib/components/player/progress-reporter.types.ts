// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// ============================================================================
// Progress Reporter Types
// ============================================================================

import type { ClientSubtitleMethod } from '$lib/schemas/playback-plan.js';

export type ProgressEventType = 'start' | 'progress' | 'stop';

export interface ProgressReportData {
    itemId: string;
    mediaSourceId: string;
    currentTime: number;
    isPaused: boolean;
    isMuted: boolean;
    volume: number;
    playMethod: string;
    playSessionId: string;
    audioStreamIndex: number | null;
    subtitleStreamIndex: number | null;
    subtitleId?: string;
    /** Local selection token belonging to this report's subtitle payload; never sent to the API. */
    subtitleSelectionRevision?: number;
    /** Local audio intent token belonging to this exact report payload. */
    audioSelectionRevision?: number;
    audioLanguage?: string;
    subtitleLanguage?: string;
    /**
     * Client's view of how subtitles are being delivered right now:
     * - 'none' when no subtitle track is active
     * - 'client_render' for PGS/VobSub/ASS (libbitsub / akarisub on canvas)
     * - 'external_vtt' for text subs served via HLS VTT
     * 'burn_in' is intentionally excluded — it is a server-only decision
     * owned by the HLS planner (see ClientSubtitleMethod in playback-plan.ts).
     */
    subtitleMethod?: ClientSubtitleMethod;
    bufferHealthSec?: number;
    maxStreamingBitrate?: number;
    playbackRate?: number;
    endReason?: 'user' | 'completion' | 'unload' | 'error' | 'switch';
    /**
     * Cumulative playing time in this session (ms). Drives the engagement-
     * based Continue Watching gate so a scrub-and-leave does not surface as
     * a CW row. Optional — older callers may omit it; the server treats
     * absence as "no engagement signal" and falls back to the legacy
     * position+percent CW heuristic.
     */
    sessionElapsedMs?: number;
}

export interface ProgressReporterConfig {
    /** Minimum interval between progress reports (ms) */
    minReportInterval?: number;
    /** Maximum gap before session is considered stale (ms) */
    maxProgressGap?: number;
    /** Debug logging function */
    log?: (...args: unknown[]) => void;
    /** Called when a playback tracking error occurs (for showing toasts) */
    onError?: (message: string, code?: string) => void;
    /** Called when a warning occurs (playback works but tracking degraded) */
    onWarning?: (message: string, code?: string) => void;
}

/**
 * Common interface for all progress reporter implementations.
 * Allows VideoPlayer to swap between Jellyfin-proxy (ProgressReporter)
 * and native session (PlaySessionReporter) without changes.
 */
export interface IProgressReporter {
    report(eventType: ProgressEventType, data: ProgressReportData): Promise<boolean>;
    /** Release resources (close SSE connections, etc.) */
    cleanup(): void;
}
