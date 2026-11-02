// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { PatUsageBatch } from '../database/queries/pat-usage.queries.js';

const FLUSH_INTERVAL_MS = 5 * 60_000;
interface PendingUsage {
    uses: number;
    usedAt: Date;
    clientIp: string | null;
    timer?: ReturnType<typeof setTimeout>;
    inFlight?: Promise<void>;
}

/**
 * Telemetry only: token validation/revocation never consults this buffer.
 * First use writes immediately; subsequent uses accumulate for five minutes.
 * Idle entries leave on the next deadline, failed batches retain every use,
 * and graceful shutdown flushes pending increments before the pool closes.
 * An abrupt process crash can lose only the unflushed in-process increments.
 */
export class PatUsageBatcher {
    private readonly pending = new Map<string, PendingUsage>();
    private closing = false;
    private shutdownPromise?: Promise<void>;

    constructor(
        private readonly write: (batch: PatUsageBatch) => Promise<void>,
        private readonly onError: (error: unknown) => void,
    ) {}

    record(tokenHash: string, clientIp?: string): Promise<void> {
        const usedAt = new Date();
        if (this.closing)
            return this.write({ tokenHash, uses: 1, usedAt, clientIp: clientIp || null });
        let entry = this.pending.get(tokenHash);
        const first = !entry;
        if (!entry) {
            entry = { uses: 0, usedAt, clientIp: null };
            this.pending.set(tokenHash, entry);
        }
        entry.uses++;
        entry.usedAt = usedAt;
        entry.clientIp = clientIp || null;
        return first ? this.flushEntry(tokenHash, entry) : Promise.resolve();
    }

    private async flushEntry(tokenHash: string, entry: PendingUsage): Promise<void> {
        if (entry.inFlight) return entry.inFlight;
        if (entry.uses === 0) {
            this.pending.delete(tokenHash);
            return;
        }
        const batch: PatUsageBatch = {
            tokenHash,
            uses: entry.uses,
            usedAt: entry.usedAt,
            clientIp: entry.clientIp,
        };
        entry.uses = 0;
        entry.inFlight = (async () => {
            try {
                await Promise.resolve().then(() => this.write(batch));
            } catch (error) {
                // New arrivals were counted separately while this write ran.
                entry.uses += batch.uses;
                throw error;
            } finally {
                entry.inFlight = undefined;
                if (!this.closing) {
                    entry.timer = setTimeout(() => {
                        entry.timer = undefined;
                        void this.flushEntry(tokenHash, entry).catch(this.onError);
                    }, FLUSH_INTERVAL_MS);
                    entry.timer.unref();
                }
            }
        })();
        return entry.inFlight;
    }

    shutdown(): Promise<void> {
        this.shutdownPromise ??= this.drain();
        return this.shutdownPromise;
    }

    private async drain(): Promise<void> {
        this.closing = true;
        for (const entry of this.pending.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        // Finish any first-use write before draining uses that arrived during it.
        await Promise.allSettled([...this.pending.values()].map((entry) => entry.inFlight));
        const results = await Promise.allSettled(
            [...this.pending].map(([hash, entry]) => this.flushEntry(hash, entry)),
        );
        const errors = results
            .filter((r) => r.status === 'rejected')
            .map((r) => r.reason as unknown);
        if (errors.length) throw new AggregateError(errors, 'Failed to flush PAT usage');
        this.pending.clear();
    }
}
