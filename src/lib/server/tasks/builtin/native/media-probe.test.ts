// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-probe native task — manifest and disable-gate tests.
 *
 * Execute behaviour (two-phase drain, backlog, listFailedItems, retryItem)
 * is covered by the existing legacy plugin tests at:
 *   plugins/builtin/sync/__tests__/media-probe-*.test.ts
 *   plugins/builtin/sync/media-probe.plugin.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mediaProbeTask } from './media-probe.js';

describe('media-probe task manifest', () => {
    it('has the correct id', () => {
        expect(mediaProbeTask.id).toBe('media-probe');
    });

    it('declares a 1h schedule with env override', () => {
        expect(mediaProbeTask.schedule).toMatchObject({
            every: '1h',
            envOverride: 'SYNC_MEDIA_PROBE_INTERVAL',
        });
    });

    it('uses io resource class', () => {
        // resourceClass changed from cpu to io in production; media-probe is
        // I/O-bound (file reads + ffprobe short jobs) not long-running CPU.
        expect(mediaProbeTask.resourceClass).toBe('io');
    });

    it('has global scope', () => {
        expect(mediaProbeTask.scope).toBe('global');
    });

    it('identityFor returns "global-catchup" for default input', () => {
        expect(mediaProbeTask.identityFor({})).toBe('global-catchup');
    });

    it('identityFor returns "global-force" for force mode', () => {
        expect(mediaProbeTask.identityFor({ mode: 'force' })).toBe('global-force');
    });

    it('wires backlog stages and wipe', () => {
        expect(typeof mediaProbeTask.backlog?.stages).toBe('function');
        expect(typeof mediaProbeTask.backlog?.wipe).toBe('function');
    });

    it('wires failures list and retry', () => {
        expect(typeof mediaProbeTask.failures?.list).toBe('function');
        expect(typeof mediaProbeTask.failures?.retry).toBe('function');
    });
});

describe('media-probe DISABLE_MEDIA_PROBE gate', () => {
    const ac = new AbortController();

    function makeCtx() {
        return {
            sql: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run',
            input: {},
            reportProgress: vi.fn(),
        };
    }

    beforeEach(() => {
        delete process.env.DISABLE_MEDIA_PROBE;
    });

    it('returns success with 0 items when DISABLE_MEDIA_PROBE=true', async () => {
        process.env.DISABLE_MEDIA_PROBE = 'true';
        const ctx = makeCtx();
        const result = await mediaProbeTask.execute(
            ctx as unknown as Parameters<typeof mediaProbeTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});
