// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Per-run cost accumulator for ctx.spend(kind, units).
//
// In-memory Map<runId, Map<kind, number>>. The runner calls costLedger.create()
// before handing ctx to the plugin and reads the snapshot on terminal transition
// to write task_history.cost_breakdown as JSONB.
//
// finalize() returns the breakdown and removes the internal entry so the map
// doesn't leak across runs.

import { REQUEST_PATH_PROVIDER_HOSTS } from '../utils/external-request-counter.js';

import { type CostKind, COST_KINDS } from '@sapd/lumastra-plugin-sdk';

/** Set for O(1) membership test at runtime. */
const COST_KINDS_SET: ReadonlySet<string> = new Set<string>(COST_KINDS);

/** Per-host cost-unit namespaces (see CostKind in the SDK). Each key is the
 *  prefix plus a DNS hostname, so a bad caller can't bloat cost_breakdown JSONB. */
const HOST_SCOPED_PREFIXES = ['api_calls:', 'api_errors:', 'api_429:'] as const;
/** Max DNS hostname length — caps every host-scoped key. */
const MAX_HOST_DNS_LEN = 253;

/**
 * Whether `kind` may be recorded. The bare COST_KINDS plus the bounded
 * per-host namespaces `api_calls:<host>`, `api_errors:<host>`, `api_429:<host>`
 * (see CostKind in the SDK). Unknown kinds are
 * rejected to keep Prometheus cardinality bounded (TASK-H19); the per-host
 * namespace is DB-only and excluded from Prometheus by writeCostBreakdown.
 */
function isAllowedCostKind(kind: string): boolean {
    if (COST_KINDS_SET.has(kind)) return true;
    for (const prefix of ['api_errors:', 'api_429:']) {
        if (kind.startsWith(prefix))
            return REQUEST_PATH_PROVIDER_HOSTS.has(kind.slice(prefix.length));
    }
    return HOST_SCOPED_PREFIXES.some(
        (prefix) => kind.startsWith(prefix) && kind.length <= prefix.length + MAX_HOST_DNS_LEN,
    );
}

export interface CostBreakdown {
    [kind: string]: number;
}

export interface CostSpend {
    spend(kind: CostKind, units: number): void;
    snapshot(): CostBreakdown;
}

export class CostLedger {
    private readonly runs = new Map<string, Map<string, number>>();

    /**
     * Create an accumulator for a new run. Returns a CostSpend handle that
     * the runner passes to the plugin via ctx.spend.
     *
     * Throws if `runId` already has a ledger — calling create() twice with the
     * same id would silently replace the map and orphan the old spend handle's
     * captured map, dropping any units it later accumulated.
     */
    create(runId: string): CostSpend {
        if (this.runs.has(runId)) {
            throw new Error(`CostLedger: runId ${runId} already exists`);
        }
        const map = new Map<string, number>();
        this.runs.set(runId, map);

        return {
            spend(kind: CostKind, units: number): void {
                // Guard against bad inputs at the boundary:
                //   - unknown kind would create an unbounded Prometheus label (cardinality explosion)
                //   - NaN serializes as null in JSONB
                //   - negative units flip the accumulator sign
                // The bounded `api_calls:<host>` namespace is allowed (DB-only,
                // filtered out of Prometheus by writeCostBreakdown).
                if (!isAllowedCostKind(kind)) return;
                if (!Number.isFinite(units) || units < 0) return;
                map.set(kind, (map.get(kind) ?? 0) + units);
            },
            snapshot(): CostBreakdown {
                const out: CostBreakdown = {};
                for (const [k, v] of map) {
                    out[k] = v;
                }
                return out;
            },
        };
    }

    /**
     * Return the final cost breakdown for a run and remove the internal entry.
     * Safe to call even if the run was never created (returns {}).
     */
    finalize(runId: string): CostBreakdown {
        const map = this.runs.get(runId);
        this.runs.delete(runId);
        if (!map) return {};
        const out: CostBreakdown = {};
        for (const [k, v] of map) {
            out[k] = v;
        }
        return out;
    }
}
