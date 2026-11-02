// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ItemStageRow } from './ingest-map.constants.js';
import type { FileHealthIssueType, StageErrorDetail } from '$lib/types/pipeline';
import type { StuckItemReason } from '$lib/schemas/ingest-map.js';

export interface MapItem {
    media_item_id: string;
    media_type: string;
    title: string;
    /** Episodes only — parent series title resolved via parent_id chain. */
    series_title?: string | null;
    season_number?: number | null;
    episode_number?: number | null;
    created_at: string;
    stages: ItemStageRow[];
}

export interface SummaryBucketCount {
    bucket_id: string;
    total: number;
    recent: number;
}

export interface ScanIssueEntry {
    // Single-sourced from pipeline.ts — this list used to be hand-copied and
    // silently drifted from what the server actually writes.
    type: FileHealthIssueType;
    detected_at: string;
    attempt_count?: number;
    next_retry_at?: string;
    detail?: string;
}

export interface ScanIssueRow {
    file_path: string;
    library_group_id: string | null;
    issues: ScanIssueEntry[];
    created_at: string;
    updated_at: string;
}

export interface StageActivityEntry {
    stage_id: string;
    last_completed_at: string | null;
    completed_5m: number;
    running: number;
    failed_1h: number;
}

/**
 * Per-resource-class queue snapshot shown in the station tooltip when a
 * stage has a backlog of `pending` items. Makes it obvious to operators
 * whether a stage is genuinely stuck or just waiting for its turn in
 * a queue that's busy with other work in the same resource class.
 *
 * Sourced from orchestrator.getQueueDepths() at page-server load time.
 */
export interface QueueDepthEntry {
    resourceClass: string;
    /** Jobs BullMQ has handed to a worker. ≤ concurrencyCap. */
    active: number;
    /** Jobs sitting in the prioritized list waiting for a slot. */
    waiting: number;
    /** Configured concurrency cap for this class (LUMASTRA_CONCURRENCY_*). */
    concurrencyCap: number;
    /** Operator pause state — when true, no jobs run regardless of depth. */
    paused: boolean;
}

export interface PipelineSummary {
    inFlight: number;
    failedLastHour: number;
    deadLetterItems: number;
    running: number;
    oldestPendingAgeSec: number | null;
    degradedItems: number;
    /**
     * Subset of `deadLetterItems` that needs re-identification (a data/
     * identity problem, not just an exhausted retry budget) — the exact
     * same count Library → Fix matches (broken-match view) shows. See the
     * server-side `IngestPipelineSummary.reidentifyItems` doc comment.
     * Optional for backward compatibility with any stale cached payload
     * (`admin:ingest:page:v2`) written before this field existed.
     */
    reidentifyItems?: number;
}

/** The API may omit details; diagnostics render only the fields that exist. */
type StageErrorClient = Partial<StageErrorDetail>;

export interface StuckItemEntry {
    media_item_id: string;
    title: string;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string;
    stage_id: string;
    status: string;
    /** Optional for snapshots cached before the selected-reason field existed. */
    reason?: StuckItemReason;
    attempt: number;
    last_error: StageErrorClient | null;
    stuck_since: string;
    stuck_age_sec: number;
}

export interface DeadLetterEntry {
    media_item_id: string;
    title: string;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string;
    stage_id: string;
    attempt: number;
    last_error: StageErrorClient | null;
    dead_since: string;
    dead_age_sec: number;
}

export interface ErrorGroupEntry {
    stage_id: string;
    fingerprint: string;
    sample_message: string;
    error_code: string | null;
    count: number;
    first_seen: string;
    last_seen: string;
}

export interface MapResponse {
    items: MapItem[];
    summaryBuckets?: SummaryBucketCount[];
    scanIssues?: ScanIssueRow[];
    stageActivity?: StageActivityEntry[];
    queueDepths?: QueueDepthEntry[];
    /**
     * Set when the page-server tried to load queueDepths but the
     * orchestrator import or `getQueueDepths()` threw. UI uses this to
     * distinguish "no contention" (empty array, no error) from "queue
     * data unavailable" (empty array WITH error) and render an "info
     * unavailable" hint instead of silently hiding the section.
     */
    queueDepthsError?: string | null;
    pipelineSummary?: PipelineSummary | null;
    stuckItems?: StuckItemEntry[];
    deadLetter?: DeadLetterEntry[];
    errorGroups?: ErrorGroupEntry[];
    window: { since: string; until: string };
    total: number;
    truncated?: boolean;
}
