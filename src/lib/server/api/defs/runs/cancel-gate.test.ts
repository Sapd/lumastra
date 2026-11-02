// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-gate contract for POST /api/v1/runs/cancel (E1 row #39).
 *
 * `byTask` is REQUIRED (min 1) — this endpoint only cancels by task id, so
 * mount() emits the 422 for a missing/empty value rather than deferring to the
 * handler's own presence check.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/tasks/orchestrator.js', () => ({ orchestrator: {} }));
vi.mock('$lib/server/tasks/registry.js', () => ({ registry: { getTask: vi.fn() } }));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn() }));

const { def } = await import('./cancel.js');
const query = def.request!.query!;

describe('POST /api/v1/runs/cancel — byTask gate', () => {
    it('accepts a non-empty byTask', () => {
        expect(query.safeParse({ byTask: 'metadata-sync' }).success).toBe(true);
    });

    it('rejects a missing byTask (now required)', () => {
        expect(query.safeParse({}).success).toBe(false);
    });

    it('rejects an empty byTask', () => {
        expect(query.safeParse({ byTask: '' }).success).toBe(false);
    });
});
