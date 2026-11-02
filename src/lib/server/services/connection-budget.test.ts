// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    evaluateConnectionBudget,
    CONNECTION_HEADROOM,
    type ConnectionBudgetInput,
} from './connection-budget.js';

// Default per-instance pools (web 8 + task 7 + admin 4 = 19), matching connection.ts.
const DEFAULT_POOLS = { web: 8, task: 7, admin: 4 };

function input(overrides: Partial<ConnectionBudgetInput> = {}): ConnectionBudgetInput {
    return {
        maxConnections: 100,
        reservedConnections: 3,
        pools: DEFAULT_POOLS,
        replicaCount: 1,
        ...overrides,
    };
}

describe('evaluateConnectionBudget', () => {
    it('passes a default single-instance install with plenty of headroom', () => {
        const r = evaluateConnectionBudget(input());
        expect(r.status).toBe('ok');
        expect(r.perInstanceTotal).toBe(19);
        expect(r.worstCaseDemand).toBe(19);
        expect(r.usableConnections).toBe(97);
        expect(r.spareConnections).toBe(78);
        expect(r.recommendation).toBeUndefined();
    });

    it('passes the guide’s large-library starting point (task pool 20, single worker)', () => {
        // LUMASTRA_DB_POOL_TASK_MAX=20 → 8 + 20 + 4 = 32 on one worker, default max_connections.
        const r = evaluateConnectionBudget(input({ pools: { web: 8, task: 20, admin: 4 } }));
        expect(r.status).toBe('ok');
        expect(r.worstCaseDemand).toBe(32);
    });

    it('flags critical when worst-case demand exceeds usable connections', () => {
        // 6 replicas × 19 = 114 > 97 usable.
        const r = evaluateConnectionBudget(input({ replicaCount: 6 }));
        expect(r.status).toBe('critical');
        expect(r.worstCaseDemand).toBe(114);
        expect(r.spareConnections).toBeLessThan(0);
        expect(r.recommendation).toContain('max_connections');
        // Recommends enough to cover demand + reserved + headroom.
        expect(r.recommendation).toContain(String(114 + 3 + CONNECTION_HEADROOM));
    });

    it('warns when demand fits but eats into the migration/psql headroom', () => {
        // Pick max_connections so usable − demand sits just inside the headroom band.
        // demand 19, want spare = 5 (< 10) → usable 24 → max 24 + reserved 3 = 27.
        const r = evaluateConnectionBudget(input({ maxConnections: 27 }));
        expect(r.status).toBe('warning');
        expect(r.spareConnections).toBe(5);
        expect(r.recommendation).toContain('max_connections');
    });

    it('treats exactly-zero spare as warning, not critical (demand fits, no headroom)', () => {
        // usable 19 == demand 19 → spare 0 is not < 0, so it is not critical;
        // 0 < CONNECTION_HEADROOM → warning. The budget fits but leaves nothing.
        const r = evaluateConnectionBudget(input({ maxConnections: 22 }));
        expect(r.spareConnections).toBe(0);
        expect(r.status).toBe('warning');
    });

    it('clamps usable connections at zero when reserved exceeds max', () => {
        const r = evaluateConnectionBudget(input({ maxConnections: 2, reservedConnections: 5 }));
        expect(r.usableConnections).toBe(0);
        expect(r.status).toBe('critical');
    });

    it('mentions replica fan-out in the detail only when multi-replica', () => {
        expect(evaluateConnectionBudget(input({ replicaCount: 1 })).detail).not.toContain(
            'replicas',
        );
        expect(evaluateConnectionBudget(input({ replicaCount: 3 })).detail).toContain('3 replicas');
    });
});
