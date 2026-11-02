// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';

// getDb → null so the ONLY thing that can 404 the bad id is the ID_PATTERN guard
// running FIRST. If the guards were inverted this would 500 'database unavailable'.
// (The def assertions below don't touch getDb, so a null mock is harmless there.)
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));

import { def } from '$lib/server/api/defs/admin/plugins/external/[id]/enable.js';

describe('admin external enable def', () => {
    it('is admin-gated and internal', () => {
        expect(def.auth).toEqual({ kind: 'admin' });
        expect(def.visibility).toBe('internal');
    });
    it('exposes only a POST handler', () => {
        expect(typeof def.handlers.POST).toBe('function');
        expect(def.handlers.GET).toBeUndefined();
    });
});

describe('admin external enable — guard order (bad id before null-DB)', () => {
    it('bad id + null DB → 404, not 500', async () => {
        const res = await def.handlers.POST!(
            { params: { id: '../etc' }, locals: {} } as never,
            {} as never,
        );
        expect(res.status).toBe(404); // ApiResponses.notFound, NOT ApiResponses.error(500)
    });
});
