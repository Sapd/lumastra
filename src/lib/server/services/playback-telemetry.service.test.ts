// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * playbackTelemetryService.cleanup() tests.
 *
 * Focused on the batched-DELETE + retention-window + abort-signal wiring
 * added for D6 — a tight unit harness that mocks the `postgres` template
 * tag so we can assert which tables get hit and how many batches run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// getDb is called lazily inside isAvailable → ensureSql. Provide a mock
// that captures every sql`` call so tests can verify the batching pattern.
type SqlCall = {
    template: TemplateStringsArray;
    values: unknown[];
    result: { count: number };
};
const sqlCalls: SqlCall[] = [];
let nextCounts: number[] = [];

function makeSqlTag(): unknown {
    const tag = (template: TemplateStringsArray, ...values: unknown[]) => {
        const count = nextCounts.shift() ?? 0;
        const result = { count };
        sqlCalls.push({ template, values, result });
        return Promise.resolve(result);
    };
    return tag;
}

vi.mock('../database/connection.js', () => ({
    getDb: () => makeSqlTag(),
}));

import { playbackTelemetryService } from './playback-telemetry.service';

function getSqlBodies(): string[] {
    return sqlCalls.map((c) => c.template.join('?'));
}

describe('playbackTelemetryService.cleanup', () => {
    beforeEach(() => {
        sqlCalls.length = 0;
        nextCounts = [];
        // Force a fresh sql tag each run
        (playbackTelemetryService as unknown as { sql: unknown }).sql = null;
    });

    it('runs a DELETE against all five retention tables', async () => {
        // One empty batch per table is enough for the loops to terminate.
        nextCounts = [0, 0, 0, 0, 0];
        await playbackTelemetryService.cleanup();

        const bodies = getSqlBodies();
        expect(bodies.some((b) => b.includes('playback_telemetry'))).toBe(true);
        expect(bodies.some((b) => b.includes('playback_session_quality'))).toBe(true);
        // network_speed_tests shares the 90-day session-quality window; the
        // speed-test rows are pruned by the same cleanup run, not a task of
        // their own, so an absent DELETE here means they are kept forever.
        expect(bodies.some((b) => b.includes('DELETE FROM network_speed_tests'))).toBe(true);
        expect(bodies.some((b) => b.includes('user_playback_quality'))).toBe(true);
        expect(bodies.some((b) => b.includes('device_playback_quality'))).toBe(true);
    });

    it('chunks deletes — loops while the batch fills the limit', async () => {
        // First table returns 10000, 10000, 0 → three queries. Others: 0 each.
        nextCounts = [10000, 10000, 0, 0, 0, 0, 0];
        const deleted = await playbackTelemetryService.cleanup();
        expect(deleted).toBe(20000);
        // First table: 3 queries; each of the other four: 1 = 7 total
        expect(sqlCalls.length).toBe(7);
    });

    it('short-circuits on abort between tables', async () => {
        const controller = new AbortController();
        nextCounts = [0]; // playback_telemetry drains immediately
        controller.abort();
        await playbackTelemetryService.cleanup(controller.signal);
        // After the first drain finishes and abort is observed, no further
        // tables are touched. (The first table still runs because abort is
        // checked only between tables / batches, not before the first call.)
        expect(sqlCalls.length).toBeLessThanOrEqual(1);
    });
});

/**
 * Regression: record() must never enqueue a non-uuid play_session_id.
 *
 * `playback_telemetry.play_session_id` is a uuid column, and a failed flush
 * re-queues the whole batch at the FRONT — so one preview id like
 * `preview-<uuid>-<millis>` (passed by the HLS segment handler's proxy_error
 * path) would become a poison pill that blocks ALL telemetry until the buffer
 * overflows. The guard drops such ids at ingress.
 */
describe('playbackTelemetryService.record — non-uuid play_session_id guard', () => {
    const VALID_UUID = 'aef86349-3899-4977-8f6c-e0abe73f1a14';
    const pending = () =>
        (playbackTelemetryService as unknown as { pendingEvents: unknown[] }).pendingEvents;

    beforeEach(() => {
        sqlCalls.length = 0;
        nextCounts = [];
        (playbackTelemetryService as unknown as { sql: unknown }).sql = null;
        pending().length = 0;
    });

    it('drops a preview/composite id instead of buffering it', async () => {
        await playbackTelemetryService.record(
            `preview-${VALID_UUID}-1783369780697`,
            'server',
            'proxy_error',
            1,
        );
        expect(pending().length).toBe(0);
    });

    it('still buffers a well-formed uuid id', async () => {
        await playbackTelemetryService.record(VALID_UUID, 'server', 'proxy_error', 1);
        expect(pending().length).toBe(1);
    });
});

/**
 * The delivery-interruptions penalty, asserted at the seam that owns it.
 *
 * `classifyDeliveryInterruption` is pure and already has its own tests, but it
 * only decides WHETHER the cause fires — the arithmetic trap this guards lives
 * one level up, in `calculateHealthScore`: a session with measured windows gets
 * its bandwidth ratio from the MEASURED p50, which on this signature sits well
 * above need where the hls.js EWMA sat below it. Diagnosing the session would
 * therefore REMOVE the old bandwidth penalty and leave it scoring higher than
 * before, so the diagnosis has to bring a penalty of its own. The method is
 * private and pure (no sql), reached with the same cast the rest of this file
 * uses for `sql`/`pendingEvents`.
 */
describe('calculateHealthScore — cause:delivery_interruptions', () => {
    type ScoreFn = (
        server: Record<string, unknown>,
        client: Record<string, unknown>,
        mediaBitrate?: number,
        bandwidthRatio?: number,
        isTranscoding?: boolean,
        delivery?: { p50: number | null; p95: number | null; p99: number | null },
        deliveryWindows?: {
            windowCount: number;
            p10Bps: number | null;
            p50Bps: number | null;
            overdueCount: number;
        },
    ) => { score: number; issues: string[] };

    const score = (...args: Parameters<ScoreFn>): ReturnType<ScoreFn> =>
        (
            playbackTelemetryService as unknown as { calculateHealthScore: ScoreFn }
        ).calculateHealthScore(...args);

    // One rebuffer is the `hasPlaybackIssue` trigger the root-cause block needs.
    const CLIENT_WITH_ISSUE = { rebuffer_count: 1 };
    const MEDIA_BITRATE = 8_000_000;

    /** Testlistener's signature: p50 comfortably above need, p10 collapsed below it. */
    const INTERRUPTED = {
        windowCount: 6,
        p10Bps: 4_000_000, // 0.5x need — below the 0.8x collapse ratio
        p50Bps: 20_000_000, // 2.5x need — above the 1.5x "normally ample" ratio
        overdueCount: 0,
    };

    it('deducts the penalty and tags both the issue and the cause', () => {
        const diagnosed = score(
            {},
            CLIENT_WITH_ISSUE,
            MEDIA_BITRATE,
            // The measured p50 is what produces this ratio — it is ample, so no
            // bandwidth penalty applies and the score would otherwise be high.
            2.5,
            false,
            undefined,
            INTERRUPTED,
        );

        expect(diagnosed.issues).toContain('cause:delivery_interruptions');
        expect(diagnosed.issues).toContain('delivery_interruptions');

        // The comparison that makes this evidence: the SAME session without the
        // delivery windows scores higher, i.e. the diagnosis costs 15 points
        // rather than being free.
        const undiagnosed = score({}, CLIENT_WITH_ISSUE, MEDIA_BITRATE, 2.5, false, undefined, {
            windowCount: 0,
            p10Bps: null,
            p50Bps: null,
            overdueCount: 0,
        });
        expect(undiagnosed.issues).not.toContain('cause:delivery_interruptions');
        expect(undiagnosed.score - diagnosed.score).toBe(15);
    });

    it('does not fire — and does not deduct — when the link is uniformly ample', () => {
        const healthy = score({}, CLIENT_WITH_ISSUE, MEDIA_BITRATE, 2.5, false, undefined, {
            windowCount: 6,
            p10Bps: 18_000_000,
            p50Bps: 20_000_000,
            overdueCount: 0,
        });

        expect(healthy.issues).not.toContain('delivery_interruptions');
        expect(healthy.issues).not.toContain('cause:delivery_interruptions');
    });
});

describe('playbackTelemetryService.settleBackgroundWork / shutdown — bounded wait', () => {
    type Internals = {
        inFlightQualityWork: Set<Promise<unknown>>;
        isShuttingDown: boolean;
        sql: unknown;
    };
    const internals = (): Internals => playbackTelemetryService as unknown as Internals;

    it('drains finished work and resolves true without a timeout', async () => {
        let release!: () => void;
        const work = new Promise<void>((r) => (release = r));
        internals().inFlightQualityWork.add(work);
        void work.then(() => internals().inFlightQualityWork.delete(work));
        const settled = playbackTelemetryService.settleBackgroundWork();
        release();
        await expect(settled).resolves.toBe(true);
        expect(internals().inFlightQualityWork.size).toBe(0);
    });

    it('shutdown() gives up on wedged quality work after 5 s instead of hanging', async () => {
        vi.useFakeTimers();
        const wedged = new Promise<void>(() => {
            /* a DB call that never returns */
        });
        internals().inFlightQualityWork.add(wedged);
        internals().sql = null;
        try {
            let done = false;
            const shutdown = playbackTelemetryService.shutdown().then(() => {
                done = true;
            });
            await vi.advanceTimersByTimeAsync(4_999);
            expect(done).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await shutdown;
            expect(done).toBe(true);
        } finally {
            internals().inFlightQualityWork.delete(wedged);
            internals().isShuttingDown = false;
            vi.useRealTimers();
        }
    });
});
