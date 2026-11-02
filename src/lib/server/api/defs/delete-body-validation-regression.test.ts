// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression coverage for a latent mount() body-validation bug: `request.body`
 * is declared once per def, and mount() applies it to every method that can
 * carry a body — POST, PUT, PATCH **and DELETE** (`methodCanHaveBody()` in
 * mount.ts). A def that declared a def-level *required* body while also
 * exposing a DELETE that sends no body 422'd on EVERY DELETE call, because an
 * empty body decodes to `{}` and fails the required fields.
 *
 * These defs had this shape and are fixed here (either dropped the def-level
 * body and validate manually in the method that needs it, mirroring
 * `defs/playlists/[id]/index.ts` / `defs/devices/[id]/push-token/index.ts`):
 *
 *   - media/[id]/provider-preference.ts
 *   - admin/media/[id]/external-ids.ts
 *   - playlists/[id]/members/[userId].ts (internal and v1)
 *   - catalog/series/ordering.ts
 *   - livetv/admin/categories/[id]/index.ts
 *
 * None of these tests mock the database — with no DATABASE_URL configured in
 * the test environment, getDb()/aiDbService.getSql() deterministically return
 * null and each handler's own "database unavailable" branch fires (503). The
 * load-bearing assertion is that mount()'s request-validation layer let the
 * DELETE call reach the handler at all (never 422 validation_failed) — if a
 * def-level body schema regresses back onto DELETE, these calls 422 before
 * getDb() is ever invoked and the assertion fails.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def as providerPreferenceDef } from './media/[id]/provider-preference.js';
import { def as externalIdsDef } from './admin/media/[id]/external-ids.js';
import { def as memberIdDef } from './playlists/[id]/members/[userId].js';
import { def as orderingDef } from './catalog/series/ordering.js';
import { def as categoryDef } from './livetv/admin/categories/[id]/index.js';

const CTX = { surface: 'internal' } as const;

function deleteEvent(url: string, params: Record<string, string>, locals: unknown): RequestEvent {
    return {
        url: new URL(url),
        request: new Request(url, { method: 'DELETE' }),
        params,
        route: { id: url },
        locals,
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('DELETE-with-no-body regression (mount() body-validation trap)', () => {
    it('media/[id]/provider-preference DELETE parses (not 422)', async () => {
        const { DELETE } = mount(providerPreferenceDef, CTX);
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/media/abc/provider-preference',
                { id: 'abc' },
                {
                    user: { isAdmin: true, username: 'admin' },
                    principal: { kind: 'session', isAdmin: true, scopes: [], username: 'admin' },
                },
            ),
        );
        expect(res.status).not.toBe(422);
        // No DATABASE_URL in test env → getDb() returns null → 503, proving the
        // request cleared body validation and reached the handler.
        expect(res.status).toBe(503);
    });

    it('admin/media/[id]/external-ids DELETE parses (not 422)', async () => {
        const { DELETE } = mount(externalIdsDef, CTX);
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/admin/media/abc/external-ids?provider=tmdb',
                { id: 'abc' },
                {
                    user: { isAdmin: true, username: 'admin' },
                    principal: { kind: 'session', isAdmin: true, scopes: [], username: 'admin' },
                },
            ),
        );
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(503);
    });

    it('playlists/[id]/members/[userId] internal DELETE parses (not 422)', async () => {
        const { DELETE } = mount(memberIdDef, CTX);
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/playlists/1/members/550e8400-e29b-41d4-a716-446655440000',
                { id: '1', userId: '550e8400-e29b-41d4-a716-446655440000' },
                { user: { username: 'alice', userId: 'u1', isAdmin: false } },
            ),
        );
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(503);
    });

    it('playlists/[id]/members/[userId] v1 DELETE parses (not 422)', async () => {
        const { DELETE } = mount(memberIdDef, { surface: 'v1' });
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/v1/playlists/1/members/11111111-1111-1111-1111-111111111111',
                { id: '1', userId: '11111111-1111-1111-1111-111111111111' },
                { user: { username: 'alice', userId: 'u1', isAdmin: false } },
            ),
        );
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(503);
    });

    it('catalog/series/ordering DELETE parses (not 422)', async () => {
        const { DELETE } = mount(orderingDef, CTX);
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/series/11111111-1111-1111-1111-111111111111/ordering',
                { id: '11111111-1111-1111-1111-111111111111' },
                {
                    user: { username: 'admin', userId: 'u1', isAdmin: true },
                    principal: {
                        kind: 'session',
                        isAdmin: true,
                        scopes: [],
                        username: 'admin',
                        userId: 'u1',
                    },
                },
            ),
        );
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(503);
    });

    it('livetv/admin/categories/[id] DELETE parses (not 422)', async () => {
        const { DELETE } = mount(categoryDef, CTX);
        const res = await DELETE!(
            deleteEvent(
                'http://localhost/api/admin/livetv/categories/11111111-1111-1111-1111-111111111111',
                { categoryId: '11111111-1111-1111-1111-111111111111' },
                {
                    principal: {
                        scopes: ['admin'],
                        isAdmin: true,
                        username: 'admin',
                        userId: 'u1',
                    },
                },
            ),
        );
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(503);
    });
});
