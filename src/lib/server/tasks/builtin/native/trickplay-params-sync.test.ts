// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * trickplay-params-sync native task — manifest and disable-gate tests.
 *
 * Execute behaviour (drain loop, backlog, listFailedItems, retryItem) is
 * covered by the ported tests at:
 *   tasks/builtin/native/__tests__/trickplay-params-*.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { trickplayParamsSyncTask } from './trickplay-params-sync.js';

describe('trickplay-params-sync task manifest', () => {
    it('has the correct id', () => {
        expect(trickplayParamsSyncTask.id).toBe('trickplay-params-sync');
    });

    it('declares a 6h schedule with env override', () => {
        expect(trickplayParamsSyncTask.schedule).toMatchObject({
            every: '6h',
            envOverride: 'SYNC_TRICKPLAY_PARAMS_INTERVAL',
        });
    });

    it('uses io resource class', () => {
        expect(trickplayParamsSyncTask.resourceClass).toBe('io');
    });

    it('has global scope', () => {
        expect(trickplayParamsSyncTask.scope).toBe('global');
    });

    // What matters is not the literal but that EVERY mode maps to ONE key:
    // exclusiveWith's mutex key is `identityKey(taskId, identityFor(input))`,
    // so a mode-suffixed identity would let the destructive `force` wipe run
    // concurrently with a catchup or manual pass it is deleting under.
    it('gives every mode the SAME identity, so exclusiveWith spans all of them', () => {
        const keys = new Set(
            [{}, { mode: 'catchup' }, { mode: 'manual' }, { mode: 'force' }].map((input) =>
                trickplayParamsSyncTask.identityFor(input as never),
            ),
        );
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('global');
    });

    it('declares the mutex that identity feeds', () => {
        expect(trickplayParamsSyncTask.exclusiveWith).toMatchObject({ scope: 'global' });
    });

    it('processingVersion is 3 (matches PROCESSING_VERSION)', () => {
        expect(trickplayParamsSyncTask.processingVersion).toBe(3);
    });

    it('wires backlog stages and wipe', () => {
        expect(typeof trickplayParamsSyncTask.backlog?.stages).toBe('function');
        expect(trickplayParamsSyncTask.backlog?.unitLabel).toBe('file links');
        expect(typeof trickplayParamsSyncTask.backlog?.wipe).toBe('function');
    });

    it('wires failures list and retry', () => {
        expect(typeof trickplayParamsSyncTask.failures?.list).toBe('function');
        expect(typeof trickplayParamsSyncTask.failures?.retry).toBe('function');
    });
});

describe('trickplay-params-sync DISABLE_TRICKPLAY_PARAMS gate', () => {
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
        delete process.env.DISABLE_TRICKPLAY_PARAMS;
    });

    it('returns success with 0 items when DISABLE_TRICKPLAY_PARAMS=true', async () => {
        process.env.DISABLE_TRICKPLAY_PARAMS = 'true';
        const ctx = makeCtx();
        const result = await trickplayParamsSyncTask.execute(
            ctx as unknown as Parameters<typeof trickplayParamsSyncTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});
