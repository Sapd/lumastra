// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * P4: `GET /runs/{id}/logs` (and its `/api/v1` twin) is gated on
 * `{kind:'scope', anyOf:['tasks:admin']}`, not the coarse `runs:read` scope.
 *
 * `runs:read` is granted to every session (`buildPrincipal` hands every
 * non-admin session `['read','write']`, and `expandScopes()` expands `read`
 * to include `runs:read`) — see `defs/runs/[id]/diagnostics.ts`'s docstring,
 * which states the same reasoning for why its own stack-trace payload can't
 * sit behind `runs:read` either. This endpoint streams a run's raw log
 * output — `meta` emitted verbatim as `extra`, including debug-level entries
 * — which can carry the same class of internal detail (file paths, task
 * input), so it needs the same operational-reads gate `diagnostics.ts` uses
 * and 2026-09-12's C16 moved other operational reads to: `tasks:admin`.
 *
 * `defs/runs/index.ts` (the list endpoint) is UNCHANGED — it stays on
 * `runs:read` per this task's ruling; this suite only covers the per-run
 * logs def.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockReadRecent = vi.fn().mockResolvedValue([]);
const mockSubscribe = vi.fn().mockResolvedValue(() => {});

vi.mock('$lib/server/tasks/log-buffer.js', () => ({
    logBuffer: {
        readRecent: (...args: unknown[]) => mockReadRecent(...args),
        subscribe: (...args: unknown[]) => mockSubscribe(...args),
    },
}));

vi.mock('$lib/server/utils/sse.js', () => ({
    SSE_KEEPALIVE_MS: 10_000,
    startSseKeepalive: vi.fn(() => () => {}),
}));

const { def } = await import('./[id]/logs.js');
const { mount } = await import('$lib/server/api/mount.js');

const RUN_ID = '11111111-2222-3333-4444-555555555555';

function makeEvent(opts: { isAdmin: boolean; scopes: string[] }): RequestEvent {
    const url = new URL(`http://localhost/api/runs/${RUN_ID}/logs`);
    const controller = new AbortController();
    return {
        url,
        params: { id: RUN_ID },
        route: { id: '/api/runs/[id]/logs' as const },
        request: new Request(url.toString(), { signal: controller.signal }),
        locals: {
            principal: {
                kind: 'session',
                userId: 'usr_1',
                username: 'alice',
                userGroups: [],
                scopes: opts.scopes,
                isAdmin: opts.isAdmin,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('P4: GET runs/{id}/logs auth gate', () => {
    it('declares {kind:"scope", anyOf:["tasks:admin"]}, matching diagnostics.ts', () => {
        expect(def.auth).toEqual({ kind: 'scope', anyOf: ['tasks:admin'] });
    });

    it('a non-admin session (runs:read via the coarse read alias, no tasks:admin) is refused with 403', async () => {
        const { GET } = mount(def, { surface: 'internal' });
        const res = await GET!(makeEvent({ isAdmin: false, scopes: ['read', 'write'] }));
        expect(res.status).toBe(403);
    });

    it('the same non-admin session is refused on the /api/v1 surface too', async () => {
        const { GET } = mount(def, { surface: 'v1' });
        const res = await GET!(makeEvent({ isAdmin: false, scopes: ['read', 'write'] }));
        expect(res.status).toBe(403);
    });

    it('an admin session (tasks:admin via the admin alias) opens the stream', async () => {
        const { GET } = mount(def, { surface: 'internal' });
        const res = await GET!(
            makeEvent({ isAdmin: true, scopes: ['admin', 'tasks:admin', 'read', 'write'] }),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('a token scoped exactly to tasks:admin (no full admin alias) also opens the stream', async () => {
        const { GET } = mount(def, { surface: 'internal' });
        const res = await GET!(makeEvent({ isAdmin: false, scopes: ['tasks:admin'] }));
        expect(res.status).toBe(200);
    });
});
