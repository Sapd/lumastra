// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// heartbeat.ts — subsystem liveness via Valkey TTL keys (Slice 0).
//
// Each ticking subsystem writes a heartbeat key `task:heartbeat:<name>` every
// tick with a GENEROUS liveness TTL (max(3 × intervalMs, 5min)). The key
// expiring ⇒ the reader reports "no heartbeat (dead)".
//
// Why the floor is generous (5min, was 90s): these tick loops share the
// worker's main event loop with the orchestration of thousands of pending runs.
// While a large backlog drains (e.g. 8k+ pending image-sync), a tick can be
// delayed well past its nominal interval — observed reconciler/scheduler gaps of
// 60–90s on a busy-but-perfectly-alive worker. The old 90s window expired on
// those gaps and flapped a false-CRITICAL "<name> has no heartbeat" while the
// subsystem was in fact reconciling/scheduling. A 5min window absorbs that
// jitter; a genuinely-dead loop is still surfaced within ~5min, and orphaned
// runs self-heal via RunLivenessAuthority's ~15min reclaim regardless — so this
// liveness alert is for operator visibility, not a tight safety gate.
//
// Design principles (Slice 0 §2):
//   - Liveness is intrinsically ephemeral → Valkey TTL, zero Postgres load.
//   - NEVER SCAN. The reader MGETs over the static SUBSYSTEM_REGISTRY.
//   - One GLOBAL key per subsystem, last-writer-wins. Leader-gated subsystems
//     are kept fresh by whichever replica is leader; if no leader, the key
//     expires (correctly surfacing "stalled").
//   - Writes are BEST-EFFORT: a Valkey failure is logged and swallowed, never
//     thrown into a tick.

import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { HeartbeatView } from '$lib/schemas/task-system-observability.schema.js';

const log = Logger.for('Heartbeat');

const KEY_PREFIX = 'task:heartbeat:';

/**
 * Floor liveness window. Generous on purpose: the tick loops share the worker's
 * main event loop, so a heavy backlog can delay a tick by tens of seconds
 * without the subsystem being dead. 5min absorbs that jitter (a genuinely-dead
 * loop is still caught within ~5min). See the module header for the rationale.
 */
const MIN_TTL_MS = 300_000;

export interface SubsystemRegistryEntry {
    name: string;
    intervalMs: number;
    leaderGated: boolean;
}

/**
 * Static source of truth for BOTH the writers' TTLs and the reader's MGET key
 * list. Adding a subsystem here is the only registration step.
 */
export const SUBSYSTEM_REGISTRY: readonly SubsystemRegistryEntry[] = [
    { name: 'scheduler', intervalMs: 10_000, leaderGated: false },
    { name: 'reconciler', intervalMs: 30_000, leaderGated: true },
    { name: 'stage-sweep', intervalMs: 60_000, leaderGated: false },
    { name: 'event-dispatcher', intervalMs: 30_000, leaderGated: true },
    { name: 'pending-write-drain', intervalMs: 5_000, leaderGated: true },
] as const;

const REGISTRY_BY_NAME = new Map(SUBSYSTEM_REGISTRY.map((e) => [e.name, e]));

interface HeartbeatPayload {
    subsystem: string;
    instanceId: string;
    lastTickAt: number;
    intervalMs: number;
    leaderGated: boolean;
    status: 'ok' | 'degraded';
    detail: Record<string, unknown>;
}

function ttlForInterval(intervalMs: number): number {
    return Math.max(3 * intervalMs, MIN_TTL_MS);
}

/**
 * Write a subsystem heartbeat. Best-effort — never throws into a tick.
 *
 * @param name   Must be a registered subsystem (see SUBSYSTEM_REGISTRY).
 * @param opts   `status` is the subsystem's self-assessment; `detail` carries
 *               its existing typed result verbatim.
 */
export async function writeHeartbeat(
    name: string,
    opts: { status: 'ok' | 'degraded'; detail: Record<string, unknown> },
): Promise<void> {
    try {
        const entry = REGISTRY_BY_NAME.get(name);
        if (!entry) {
            // Programming error — a write for an unregistered subsystem would be
            // invisible to the reader (which only MGETs registered keys).
            log.warn('writeHeartbeat: unknown subsystem — skipping', { name });
            return;
        }
        const client = getCoordinationClient();
        if (!client) return; // Valkey down → liveness re-warms within one tick.

        const payload: HeartbeatPayload = {
            subsystem: name,
            instanceId: config.INSTANCE_ID,
            lastTickAt: Date.now(),
            intervalMs: entry.intervalMs,
            leaderGated: entry.leaderGated,
            status: opts.status,
            detail: opts.detail,
        };
        const ttlMs = ttlForInterval(entry.intervalMs);
        await client.customCommand([
            'SET',
            `${KEY_PREFIX}${name}`,
            JSON.stringify(payload),
            'PX',
            String(ttlMs),
        ]);
    } catch (err) {
        log.warn('writeHeartbeat failed (best-effort)', {
            name,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Liveness-only heartbeat, written at the START of a monitored loop's tick —
 * BEFORE its (possibly slow, or throwing) work. The loop's richer end-of-tick
 * `writeHeartbeat` (carrying the tick's result detail) still lands; this one
 * guarantees the subsystem reads as ALIVE even when a single tick runs long on
 * a large install, or throws mid-tick (e.g. a transient DB blip), instead of
 * flapping a false-CRITICAL "<name> has no heartbeat". It is the ONE definition
 * of "beat at tick-start" — previously hand-rolled per loop and missing from
 * several, which is exactly what let reconciler / stage-sweep flap under backlog
 * load.
 *
 * Leader-gated subsystems MUST call this only AFTER confirming they hold
 * leadership, so a non-leader can't keep the key warm and mask a "no leader"
 * outage.
 */
export async function beatAlive(name: string): Promise<void> {
    await writeHeartbeat(name, { status: 'ok', detail: { phase: 'tick-start' } });
}

/**
 * Read all subsystem heartbeats via a single MGET over the static registry.
 * Never SCANs. Absent key → `{ name, alive: false, leaderGated }`; present →
 * parsed + `ageMs` + `alive = ageMs < ttl`.
 */
export async function readHeartbeats(): Promise<HeartbeatView[]> {
    const now = Date.now();
    const names = SUBSYSTEM_REGISTRY.map((e) => e.name);

    let raw: unknown[] = [];
    try {
        const client = getCoordinationClient();
        if (client) {
            const keys = names.map((n) => `${KEY_PREFIX}${n}`);
            const result = await client.customCommand(['MGET', ...keys]);
            if (Array.isArray(result)) raw = result;
        }
    } catch (err) {
        log.warn('readHeartbeats: MGET failed', {
            err: err instanceof Error ? err.message : String(err),
        });
    }

    return SUBSYSTEM_REGISTRY.map((entry, i): HeartbeatView => {
        const value = raw[i];
        const str = glideToString(value);
        if (!str) {
            return {
                name: entry.name,
                alive: false,
                leaderGated: entry.leaderGated,
            };
        }
        let parsed: HeartbeatPayload | null;
        try {
            parsed = JSON.parse(str) as HeartbeatPayload;
        } catch {
            // best-effort: unparseable heartbeat payload → treat subsystem as not-alive below.
            parsed = null;
        }
        if (!parsed || typeof parsed.lastTickAt !== 'number') {
            return {
                name: entry.name,
                alive: false,
                leaderGated: entry.leaderGated,
            };
        }
        const ageMs = now - parsed.lastTickAt;
        const ttlMs = ttlForInterval(entry.intervalMs);
        return {
            name: entry.name,
            alive: ageMs < ttlMs,
            leaderGated: entry.leaderGated,
            instanceId: parsed.instanceId,
            lastTickAt: parsed.lastTickAt,
            intervalMs: parsed.intervalMs,
            ageMs,
            status: parsed.status,
            detail: parsed.detail,
        };
    });
}

/** GlideString (string | Uint8Array | Buffer) → string | null. */
function glideToString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array || value instanceof Buffer) {
        return Buffer.from(value).toString('utf-8');
    }
    return null;
}
