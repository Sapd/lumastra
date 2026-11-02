// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    findRowsByItem: vi.fn(),
}));

const mockSql = {} as never;
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => mockSql),
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: {
        resolveAnyMediaId: vi.fn(async (rawId: string) => {
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId)) {
                return { internalId: rawId, source: 'uuid' };
            }
            // Composite e.g. `tmdb:550:movie`
            if (/^[a-z]+:[^:]+:[a-z]+$/i.test(rawId)) {
                return {
                    internalId: '11111111-1111-1111-1111-111111111111',
                    source: 'composite',
                };
            }
            throw new Error(
                `Invalid media ID format: ${rawId} (expected UUID or provider:id:mediaType)`,
            );
        }),
    },
}));

import { GET } from './+server.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const BASE_URL = 'http://test/api/admin/media/x/pipeline';

describe('GET /api/admin/media/[id]/pipeline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns rows + summary for admin', async () => {
        const mockRows = [
            {
                stage_id: 'a',
                status: 'completed',
                processing_version: 1,
                attempt: 0,
                last_run_id: null,
                last_error: null,
                skipped_reason: null,
                started_at: null,
                completed_at: new Date(),
                next_eligible_at: null,
                updated_at: new Date(),
                media_item_id: VALID_UUID,
            },
            {
                stage_id: 'b',
                status: 'pending',
                processing_version: 1,
                attempt: 0,
                last_run_id: null,
                last_error: null,
                skipped_reason: null,
                started_at: null,
                completed_at: null,
                next_eligible_at: null,
                updated_at: new Date(),
                media_item_id: VALID_UUID,
            },
            {
                stage_id: 'c',
                status: 'failed_permanent',
                processing_version: 1,
                attempt: 3,
                last_run_id: 'run-x',
                last_error: { message: 'boom' },
                skipped_reason: null,
                started_at: null,
                completed_at: null,
                next_eligible_at: null,
                updated_at: new Date(),
                media_item_id: VALID_UUID,
            },
            {
                stage_id: 'd',
                status: 'obsolete',
                processing_version: 1,
                attempt: 0,
                last_run_id: null,
                last_error: null,
                skipped_reason: null,
                started_at: null,
                completed_at: null,
                next_eligible_at: null,
                updated_at: new Date(),
                media_item_id: VALID_UUID,
            },
        ];
        vi.mocked(findRowsByItem).mockResolvedValue(mockRows as never);

        expect(GET).toBeDefined();
        const res = await GET!({
            params: { id: VALID_UUID },
            locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
            request: new Request(BASE_URL),
            url: new URL(BASE_URL),
        } as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.summary).toEqual({
            total: 4,
            completed: 1,
            in_progress: 0,
            failed: 1,
            pending: 1,
            skipped: 0,
            obsolete: 1,
        });
        expect(body.rows).toHaveLength(4);
    });

    it('returns 403 for non-admin', async () => {
        expect(GET).toBeDefined();
        const res = await GET!({
            params: { id: VALID_UUID },
            locals: { user: { ownerIsAdmin: false }, principal: { isAdmin: false } },
            request: new Request(BASE_URL),
            url: new URL(BASE_URL),
        } as never);
        // enforce('admin'): the principal's verdict is final (non-admin → 403);
        // no Bearer lookup runs while a principal is present.
        expect(res.status).toBe(403);
    });

    it('returns empty arrays / zero summary for unknown id', async () => {
        vi.mocked(findRowsByItem).mockResolvedValue([]);
        expect(GET).toBeDefined();
        const res = await GET!({
            params: { id: '00000000-0000-0000-0000-000000000000' },
            locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
            request: new Request(BASE_URL),
            url: new URL(BASE_URL),
        } as never);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.rows).toEqual([]);
        expect(body.summary.total).toBe(0);
    });

    it.each(['not-a-uuid-or-composite', 'tmdb:550:movie'])(
        'answers a non-uuid id (%s) with 404 without querying',
        async (id) => {
            // These admin routes take the item UUID only (adminMediaId): no
            // middleware resolves aliases on them, and the raw value used to
            // reach a uuid column. A test that injected locals.resolvedIds by
            // hand passed here while production never set it.
            expect(GET).toBeDefined();
            const res = await GET!({
                params: { id },
                locals: { user: { ownerIsAdmin: true }, principal: { isAdmin: true } },
                request: new Request(BASE_URL),
                url: new URL(BASE_URL),
            } as never);
            expect(res.status).toBe(404);
            expect(vi.mocked(findRowsByItem)).not.toHaveBeenCalled();
        },
    );
});
