// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Moves Live TV failure events from Valkey into Postgres.
 *
 * The Rust stream proxy is a standalone service without database credentials.
 * It pushes onto a capped Valkey list over the CACHE_URL it already has for its
 * heartbeat; this is the other half of that hop.
 *
 * The batch is consumed with a single atomic `LPOP key <count>`, NOT `LRANGE` plus a
 * positional `LTRIM`. Two drains overlap routinely — the Live TV settings page drains
 * on load while the 60s timer is mid-pass — and the two-step form has both passes read
 * the same head slice and then trim twice, so the second trim deletes a slice nobody
 * ever read. `ON CONFLICT (event_uid) DO NOTHING` prevents DUPLICATION, not loss; only
 * a destructive read hands each pass a disjoint batch.
 */
import { lPopCount } from '../../cache/valkey.js';
import { getDb } from '../../database/connection.js';
import { recordLiveTvFailureEvent } from '../../database/queries/livetv-failure-events.queries.js';
import { applyFailureEventToHealth } from './channel-health.service.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import {
    LIVETV_FAILURE_QUEUE_KEY,
    type LiveTvFailureEvent,
} from '../../../../shared/livetv-failure-event.js';
import { isLiveTvFailureReason } from '../../../../shared/livetv-failure-reason.js';

const logger = Logger.for('LiveTvFailureDrain');

/** Events moved per pass. Bounded so a backlog cannot monopolise one tick. */
const DRAIN_BATCH = 100;

const DRAIN_INTERVAL_MS = 60_000;

const SOURCES = new Set(['ingest', 'egress', 'adaptive-egress']);
const OUTCOMES = new Set(['spawn_failed', 'crashed', 'stalled', 'exhausted']);

/** A non-negative integer, or undefined. Optional fields never reject an event. */
function optionalIndex(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Accept only well-formed events.
 *
 * A malformed entry (a truncated push, an older proxy build) must be DROPPED rather
 * than retried forever — leaving it at the head of the list would wedge the drain and
 * silently stop persisting every event behind it.
 */
function parseEvent(raw: string): LiveTvFailureEvent | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null) return null;
    const e = value as Record<string, unknown>;
    if (typeof e.eventUid !== 'string' || e.eventUid.length === 0) return null;
    if (typeof e.channelId !== 'string' || e.channelId.length === 0) return null;
    if (typeof e.occurredAt !== 'string') return null;
    if (typeof e.source !== 'string' || !SOURCES.has(e.source)) return null;
    if (typeof e.outcome !== 'string' || !OUTCOMES.has(e.outcome)) return null;
    const upstreamStatus = optionalIndex(e.upstreamStatus);
    const streamUrlIndex = optionalIndex(e.streamUrlIndex);

    return {
        eventUid: e.eventUid,
        channelId: e.channelId,
        occurredAt: e.occurredAt,
        source: e.source as LiveTvFailureEvent['source'],
        outcome: e.outcome as LiveTvFailureEvent['outcome'],
        exitCode: typeof e.exitCode === 'number' ? e.exitCode : null,
        signal: typeof e.signal === 'string' ? e.signal : null,
        rungId: typeof e.rungId === 'string' ? e.rungId : null,
        stderrTail: typeof e.stderrTail === 'string' ? e.stderrTail : '',
        probe: e.probe ?? null,
        decision: e.decision ?? null,
        // Optional (newer proxies): an unknown reason or a malformed value is dropped
        // field by field rather than costing the whole event.
        ...(isLiveTvFailureReason(e.reason) ? { reason: e.reason } : {}),
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
        ...(streamUrlIndex !== undefined ? { streamUrlIndex } : {}),
        ...(typeof e.feedId === 'string' && e.feedId.length > 0 ? { feedId: e.feedId } : {}),
    };
}

/**
 * Move one batch. Returns how many events were persisted (malformed entries and
 * duplicates are consumed but not counted). Never throws — it runs on a timer and behind a page
 * load, and neither caller should be able to fail because Valkey blinked.
 */
export async function drainLiveTvFailureEvents(): Promise<number> {
    try {
        const sql = getDb();
        if (!sql) return 0;

        const raw = await lPopCount(LIVETV_FAILURE_QUEUE_KEY, DRAIN_BATCH);
        if (raw.length === 0) return 0;

        let persisted = 0;
        let malformed = 0;
        for (const entry of raw) {
            const event = parseEvent(entry);
            if (!event) {
                malformed++;
                continue;
            }
            // Non-throwing by contract — a bad row must not abort the loop and strand
            // the rest of an already-popped batch.
            const inserted = await recordLiveTvFailureEvent(sql, event);
            // Also non-throwing: a typed reason moves the feed's consecutive-failure count.
            // Only for a row this pass inserted: a duplicate uid (retried push) was counted
            // by the pass that persisted it.
            if (inserted) {
                await applyFailureEventToHealth(sql, event);
                persisted++;
            }
        }

        if (malformed > 0) {
            logger.warn('Dropped malformed livetv failure events', { malformed });
        }
        return persisted;
    } catch (err) {
        logger.warn('Live TV failure drain pass failed', { error: String(err) });
        return 0;
    }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic drain. Idempotent.
 *
 * Gated on `LIVETV_SOURCE === 'standalone'` — the queue only ever has entries when
 * the stream proxy is the Live TV backend.
 */
export function startLiveTvFailureDrain(): void {
    if (intervalHandle) return;
    if (config.LIVETV_SOURCE !== 'standalone') return;
    intervalHandle = setInterval(() => void drainLiveTvFailureEvents(), DRAIN_INTERVAL_MS);
    // Never hold the process open for a diagnostics drain.
    intervalHandle.unref?.();
    logger.info('Live TV failure drain started', { intervalMs: DRAIN_INTERVAL_MS });
}

/** Stop the periodic drain (tests, shutdown). */
export function stopLiveTvFailureDrain(): void {
    if (!intervalHandle) return;
    clearInterval(intervalHandle);
    intervalHandle = null;
}
