// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const SyncRequestSchema = z.object({
    includeChildren: z.boolean().optional().default(false),
    /**
     * When syncing a series with children, whether to override per-episode
     * `metadata_locked` flags. Defaults to false — admin "Sync now" refreshes
     * the series row but preserves user-curated child edits. Set true only
     * after explicit user confirmation in the UI.
     */
    forceChildren: z.boolean().optional().default(false),
});
export type SyncRequest = z.infer<typeof SyncRequestSchema>;

export const SyncResponseSchema = z.object({
    success: z.boolean(),
    updated: z.boolean(),
    fieldsChanged: z.array(z.string()),
    seasonsSynced: z.number().optional(),
    episodesSynced: z.number().optional(),
});
export type SyncResponse = z.infer<typeof SyncResponseSchema>;

// Response for enqueued BullMQ jobs (series sync, chapter sync, etc.)
export const SyncEnqueuedResponseSchema = z.object({
    success: z.boolean(),
    started: z.boolean(),
    runId: z.string(),
    /**
     * True when the request landed on an already-running run instead of
     * enqueueing a new one. Optional so a client validating against an older
     * server still parses — but it MUST be declared here: `apiFetch` parses
     * responses with this schema and Zod objects strip undeclared keys, so an
     * omission silently deletes the flag before any caller sees it.
     */
    deduped: z.boolean().optional(),
});
export type SyncEnqueuedResponse = z.infer<typeof SyncEnqueuedResponseSchema>;
