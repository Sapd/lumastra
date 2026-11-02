// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manifest lock for the artwork reaper.
 *
 * The reaper does mass per-file `stat` over NFS and irreversible DELETEs. The
 * two properties that keep that safe are structural, not behavioural: it must
 * NOT sit on the `ingest` fast lane (2 concurrent jobs, "new file just
 * arrived" latency — the documented wedge hazard), and it must never run two
 * sweeps at once. A regression on either is silent at runtime, so it is
 * asserted here.
 */
import { describe, it, expect } from 'vitest';
import { artworkReaperTask } from '../artwork-reaper.js';

describe('artwork-reaper manifest', () => {
    it('is a single-concurrency maintenance task, never on the ingest lane', () => {
        expect(artworkReaperTask.id).toBe('artwork-reaper');
        expect(artworkReaperTask.resourceClass).toBe('maintenance');
        expect(artworkReaperTask.quotas?.maxConcurrent).toBe(1);
    });

    it('is flagged destructive and gated behind a confirmation dialog', () => {
        expect(artworkReaperTask.destructive).toBe(true);
        expect(artworkReaperTask.confirmBeforeRun).toBe(true);
    });

    it('declares no pipeline stages', () => {
        // The unit of work is an artwork ROW; media_item_stage_state has no
        // artwork-type dimension, so a coversStages entry here could never
        // reach a terminal state. Declaring one would also drag in the
        // STAGE_APPLIES_TO / STAGE_RESOURCE_CLASS mirror lint gate.
        expect(artworkReaperTask.coversStages).toBeUndefined();
    });

    it('bounds the operator limit inputs', () => {
        expect(artworkReaperTask.inputSchema.parse({ limit: 500 })).toMatchObject({ limit: 500 });
        expect(artworkReaperTask.inputSchema.parse({})).toEqual({});
        expect(() => artworkReaperTask.inputSchema.parse({ limit: 0 })).toThrow();
        expect(() => artworkReaperTask.inputSchema.parse({ limit: 20001 })).toThrow();
        expect(() => artworkReaperTask.inputSchema.parse({ missThreshold: 0 })).toThrow();
    });
});
