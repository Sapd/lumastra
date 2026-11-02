// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// log-buffer.ts — per-run Valkey LIST + pubsub live tail.
//
// Stores log entries in `task:log:<runId>` (LPUSH, LTRIM to 1000, TTL 24h).
// Publishes each entry to `task:log-stream:<runId>` for SSE consumers.
// Byte caps: 4KB per line (truncate with marker), 4MB per run (drop + one marker).

import {
    getCoordinationClient,
    subscribeToChannel,
    publishMessage,
} from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike, errMessage } from './valkey-types.js';

const log = Logger.for('LogBuffer');

// ── Constants ─────────────────────────────────────────────────────────────────

const PER_LINE_BYTES = 4096;
const PER_RUN_BYTES = 4 * 1024 * 1024;
const LIST_TTL_SEC = 24 * 3600;
const LIST_TRIM = 1000;
// Bytes reserved for the truncation suffix in the truncated message.
const PER_LINE_TRUNCATION_SUFFIX_BYTES = 64;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LogEntry {
    ts: number;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    meta?: Record<string, unknown>;
    /**
     * Monotonic per-run sequence number assigned at write time. The SSE
     * endpoint uses this as the `id:` field so reconnects with
     * `Last-Event-ID` can resume cleanly, and two entries written within
     * the same millisecond don't collide on `ts`. Optional on read so older
     * cached entries that predate this field still parse.
     */
    seq?: number;
}

// ── LogBuffer ─────────────────────────────────────────────────────────────────

export class LogBuffer {
    constructor(
        private readonly getClient: () => ValkeyLike | null = defaultGetClient,
        // Pub/sub always rides the CACHE client (eviction-immune; the live-tail
        // subscriber also subscribes there) — injected so a two-instance split
        // can't strand subscribers, and so tests can spy on it. Keyed LIST/INCR
        // writes go to the coordination client via getClient.
        private readonly publish: (
            channel: string,
            message: string,
        ) => Promise<unknown> = publishMessage,
    ) {}

    /**
     * Append a log entry for a run.
     *
     * Per-line cap: if the serialized entry exceeds 4KB, the message is
     * truncated and a `[truncated:N more bytes]` suffix is appended.
     *
     * Per-run cap: tracked via `task:log-bytes:<runId>`. Once the total
     * exceeds 4MB, a single `[per-run-log-cap-exceeded]` marker is written,
     * then subsequent entries are silently dropped.
     */
    async append(runId: string, entry: LogEntry): Promise<void> {
        const client = this.getClient();
        if (!client) return;

        // Assign a monotonic per-run sequence so SSE consumers can dedupe
        // and resume cleanly. INCR + EXPIRE is cheap (~one round-trip)
        // and gives us a stable id even for entries that share `ts`.
        const seqKey = `task:log-seq:${runId}`;
        let seq = entry.seq;
        if (seq === undefined) {
            try {
                const raw = await client.customCommand(['INCR', seqKey]);
                seq = Number(raw ?? 0);
                await client.customCommand(['EXPIRE', seqKey, String(LIST_TTL_SEC)]);
            } catch (err) {
                log.warn('LogBuffer: INCR seq failed, falling back to ts', {
                    runId,
                    err: errMessage(err),
                });
                seq = entry.ts;
            }
        }
        const stamped: LogEntry = { ...entry, seq };

        // Per-line cap — truncate message, keep meta intact.
        // Caps are byte-budgets, not char-budgets — measure UTF-8 byte length
        // so multibyte content (emojis, CJK, accented chars) can't bypass.
        let serialized = JSON.stringify(stamped);
        if (Buffer.byteLength(serialized, 'utf8') >= PER_LINE_BYTES) {
            const maxMsgLen = PER_LINE_BYTES - PER_LINE_TRUNCATION_SUFFIX_BYTES;
            const overflow = stamped.message.length - maxMsgLen;
            const truncMsg = `${stamped.message.slice(0, maxMsgLen)}... [truncated:${overflow} more bytes]`;
            serialized = JSON.stringify({ ...stamped, message: truncMsg });
        }

        // Per-run cap check. Use INCRBY for an atomic byte accumulator and
        // SETNX for a one-shot marker so concurrent appenders cannot emit
        // the cap-exceeded marker twice or smuggle entries past it.
        const byteCountKey = `task:log-bytes:${runId}`;
        const markerKey = `task:log-cap-marker:${runId}`;
        const listKey = `task:log:${runId}`;
        const streamChannel = `task:log-stream:${runId}`;

        // INCRBY by this line's byte cost (UTF-8, not chars). If we're at or
        // already over the cap, bail out — but only after racing for the
        // one-shot marker via SETNX. `>=` so a write that exactly equals the
        // cap also trips the marker, instead of slipping through.
        const lineBytes = Buffer.byteLength(serialized, 'utf8');
        let newTotal: number;
        try {
            const raw = await client.customCommand(['INCRBY', byteCountKey, String(lineBytes)]);
            newTotal = Number(raw ?? 0);
            await client.customCommand(['EXPIRE', byteCountKey, String(LIST_TTL_SEC)]);
        } catch (err) {
            log.warn('LogBuffer: INCRBY byte counter failed', {
                runId,
                err: errMessage(err),
            });
            return;
        }

        if (newTotal >= PER_RUN_BYTES) {
            // Past the cap — only the first appender that wins the SETNX
            // race writes the marker. Everyone else silently drops.
            let wonMarker = false;
            try {
                const res = await client.customCommand([
                    'SET',
                    markerKey,
                    '1',
                    'NX',
                    'EX',
                    String(LIST_TTL_SEC),
                ]);
                wonMarker = res === 'OK';
            } catch (err) {
                log.warn('LogBuffer: marker SETNX failed', {
                    runId,
                    err: errMessage(err),
                });
            }

            if (wonMarker) {
                const marker = JSON.stringify({
                    ts: Date.now(),
                    level: 'warn',
                    message: '[per-run-log-cap-exceeded]',
                });
                try {
                    await client.customCommand(['LPUSH', listKey, marker]);
                    await client.customCommand(['LTRIM', listKey, '0', String(LIST_TRIM - 1)]);
                    await client.customCommand(['EXPIRE', listKey, String(LIST_TTL_SEC)]);
                } catch (err) {
                    log.warn('LogBuffer: cap-marker LPUSH failed', {
                        runId,
                        err: errMessage(err),
                    });
                }
            }
            return;
        }

        // Normal write path.
        try {
            await client.customCommand(['LPUSH', listKey, serialized]);
            await client.customCommand(['LTRIM', listKey, '0', String(LIST_TRIM - 1)]);
            await client.customCommand(['EXPIRE', listKey, String(LIST_TTL_SEC)]);
        } catch (err) {
            log.warn('LogBuffer: LPUSH failed', {
                runId,
                err: errMessage(err),
            });
            return;
        }

        // Pubsub for live tail — best-effort, on the cache client.
        try {
            await this.publish(streamChannel, serialized);
        } catch (err) {
            log.warn('LogBuffer: PUBLISH failed', {
                runId,
                err: errMessage(err),
            });
        }
    }

    /**
     * Read the most recent `count` log entries in chronological order.
     * The LIST is LPUSH'd (newest at index 0), so LRANGE [0, count-1] gives
     * newest-first; we reverse for chronological output.
     */
    async readRecent(runId: string, count: number = 200): Promise<LogEntry[]> {
        const client = this.getClient();
        if (!client) return [];

        let raw: unknown;
        try {
            raw = await client.customCommand([
                'LRANGE',
                `task:log:${runId}`,
                '0',
                String(count - 1),
            ]);
        } catch (err) {
            log.warn('LogBuffer: LRANGE failed', {
                runId,
                err: errMessage(err),
            });
            return [];
        }

        if (!Array.isArray(raw)) return [];

        const entries: LogEntry[] = [];
        for (const item of raw) {
            const str = typeof item === 'string' ? item : null;
            if (!str) continue;
            try {
                entries.push(JSON.parse(str) as LogEntry);
            } catch {
                // Skip malformed entries.
            }
        }

        // Reverse so index 0 = oldest (chronological order).
        entries.reverse();
        return entries;
    }

    /**
     * Subscribe to the live log stream for a run.
     * Returns an unsubscribe function.
     */
    async subscribe(
        runId: string,
        onEntry: (entry: LogEntry) => void,
    ): Promise<() => Promise<void>> {
        const channel = `task:log-stream:${runId}`;
        const handler = (raw: string): void => {
            try {
                onEntry(JSON.parse(raw) as LogEntry);
            } catch {
                // Skip malformed pubsub messages.
            }
        };

        try {
            const unsub = await subscribeToChannel(channel, handler);
            if (unsub) return unsub;
        } catch (err) {
            log.warn('LogBuffer: subscribe failed', {
                runId,
                err: errMessage(err),
            });
        }

        return async () => {};
    }
}

// ── Module-level singleton ────────────────────────────────────────────────────

function defaultGetClient(): ValkeyLike | null {
    return getCoordinationClient() as unknown as ValkeyLike | null;
}

export const logBuffer = new LogBuffer();
