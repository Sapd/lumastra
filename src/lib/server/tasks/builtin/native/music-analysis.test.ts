// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-analysis native task — manifest and disable-gate tests.
 *
 * Execute behaviour (drain loop, backlog, listFailedItems, retryItem,
 * processItems) is covered by the ported tests at:
 *   tasks/builtin/native/__tests__/music-analysis-*.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { musicAnalysisTask } from './music-analysis.js';

describe('music-analysis task manifest', () => {
    it('has the correct id', () => {
        expect(musicAnalysisTask.id).toBe('music-analysis');
    });

    it('declares a 6h schedule with env override', () => {
        expect(musicAnalysisTask.schedule).toMatchObject({
            every: '6h',
            envOverride: 'SYNC_MUSIC_ANALYSIS_INTERVAL',
        });
    });

    it('uses cpu resource class (Essentia is CPU-intensive)', () => {
        expect(musicAnalysisTask.resourceClass).toBe('cpu');
    });

    it('has global scope', () => {
        expect(musicAnalysisTask.scope).toBe('global');
    });

    // What matters is not the literal but that EVERY mode maps to ONE key:
    // exclusiveWith's mutex key is `identityKey(taskId, identityFor(input))`,
    // so a mode-suffixed identity would let the destructive `force` wipe run
    // concurrently with a catchup or manual pass it is deleting under.
    it('gives every mode the SAME identity, so exclusiveWith spans all of them', () => {
        const keys = new Set(
            [{}, { mode: 'catchup' }, { mode: 'manual' }, { mode: 'force' }].map((input) =>
                musicAnalysisTask.identityFor(input as never),
            ),
        );
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('global');
    });

    it('declares the mutex that identity feeds', () => {
        expect(musicAnalysisTask.exclusiveWith).toMatchObject({ scope: 'global' });
    });

    it('processingVersion matches the module PROCESSING_VERSION', () => {
        expect(musicAnalysisTask.processingVersion).toBe(7);
    });

    it('wires backlog stages and wipe', () => {
        expect(typeof musicAnalysisTask.backlog?.stages).toBe('function');
        expect(typeof musicAnalysisTask.backlog?.wipe).toBe('function');
    });

    it('wires failures list and retry', () => {
        expect(typeof musicAnalysisTask.failures?.list).toBe('function');
        expect(typeof musicAnalysisTask.failures?.retry).toBe('function');
    });

    it('wires processItems for incremental analysis', () => {
        expect(typeof musicAnalysisTask.processItems).toBe('function');
    });
});

describe('music-analysis DISABLE_MUSIC_ANALYSIS gate', () => {
    const ac = new AbortController();

    function makeCtx() {
        return {
            sql: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run',
            input: {},
            reportProgress: vi.fn(),
        };
    }

    beforeEach(() => {
        delete process.env.DISABLE_MUSIC_ANALYSIS;
    });

    it('returns success with 0 items when DISABLE_MUSIC_ANALYSIS=true', async () => {
        process.env.DISABLE_MUSIC_ANALYSIS = 'true';
        const ctx = makeCtx();
        const result = await musicAnalysisTask.execute(
            ctx as unknown as Parameters<typeof musicAnalysisTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});
