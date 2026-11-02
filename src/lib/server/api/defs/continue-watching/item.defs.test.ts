// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavioural tests for DELETE /api/v1/continue-watching/{id} and its internal
 * twin DELETE /api/continue-watching/{itemId}.
 *
 * These drive the REAL route modules, and — crucially — key the event's params
 * off the route directory name read from disk rather than a name written here
 * by hand. That is the whole point of the file.
 *
 * The bug this pins: the shared def read `params.itemId` only, while the v1
 * mount lives under `[id]`. SvelteKit therefore supplied `id` and the def's own
 * guard answered 422 `{field:'itemId'}` to EVERY v1 request — unsatisfiable
 * from any client, since no request shape can add a path param the route does
 * not declare. A test that called the handler directly with
 * `params: { itemId }` would have passed throughout, which is exactly why the
 * param key here is derived from the filesystem instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ─────────────────────────────────────────────────────────────
// `$lib/server/config.js` is deliberately NOT mocked: a partial stub throws at
// import because TaskRegistry reads FEATURE_PER_TASK_QUEUES at module scope.

const { mockClearWatchProgress } = vi.hoisted(() => ({
    mockClearWatchProgress: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// The handler reaches the service through a dynamic import; the specifier must
// match the one in the def verbatim or the mock silently no-ops.
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: { clearWatchProgress: (...a: unknown[]) => mockClearWatchProgress(...a) },
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import * as v1Route from '../../../../../routes/api/v1/continue-watching/[id]/+server.js';
import * as internalRoute from '../../../../../routes/api/continue-watching/[itemId]/+server.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../../../../..');

/**
 * The path-param name SvelteKit will bind for a route, read from the directory
 * that actually defines it. Encoding the name by hand is the failure mode this
 * whole file exists to prevent.
 */
function boundParamName(routeDir: string): string {
    const dir = readdirSync(join(repoRoot, routeDir), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('[') && e.name.endsWith(']'))
        .map((e) => e.name);

    expect(dir, `expected exactly one param directory under ${routeDir}`).toHaveLength(1);
    return dir[0].slice(1, -1);
}

const V1_PARAM = boundParamName('src/routes/api/v1/continue-watching');
const INTERNAL_PARAM = boundParamName('src/routes/api/continue-watching');

const MEDIA_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeEvent(opts: {
    paramName: string;
    routeId: string;
    path: string;
    authenticated?: boolean;
}): RequestEvent {
    const user = opts.authenticated
        ? {
              userId: toUserId(USER_ID),
              username: 'alice',
              groups: '',
              userGroups: [] as string[],
              hasWatchPermission: true,
              hasLiveTvPermission: false,
              hasRequestPermission: false,
              isAdmin: false,
              isModerator: false,
              maxAgeRating: null as null | number,
              isAgeRestricted: false,
              liveTvPriority: 'low' as const,
          }
        : null;

    const url = `http://localhost${opts.path}`;
    return {
        url: new URL(url),
        request: new Request(url, { method: 'DELETE' }),
        // Only the key the ROUTE declares — a real request can never carry the
        // other one.
        params: { [opts.paramName]: MEDIA_ID },
        route: { id: opts.routeId },
        locals: { user },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('DELETE continue-watching item', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClearWatchProgress.mockResolvedValue(undefined);
    });

    it('is reachable — the v1 route re-exports a DELETE', () => {
        expect((v1Route as Record<string, unknown>).DELETE).toBeTypeOf('function');
    });

    it('clears the item on the v1 surface using the param the route actually binds', async () => {
        const res = await v1Route.DELETE!(
            makeEvent({
                paramName: V1_PARAM,
                routeId: `/api/v1/continue-watching/[${V1_PARAM}]`,
                path: `/api/v1/continue-watching/${MEDIA_ID}`,
                authenticated: true,
            }),
        );

        // A 422 here means the def is reading a param name the route never
        // supplies: no client can satisfy it.
        expect(res.status).not.toBe(422);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cleared: true, itemId: MEDIA_ID });
        expect(mockClearWatchProgress).toHaveBeenCalledWith({
            userId: USER_ID,
            mediaId: MEDIA_ID,
        });
    });

    it('clears the item on the internal surface using its own bound param', async () => {
        // Guards the other direction: fixing v1 must not break the SPA route.
        const res = await internalRoute.DELETE!(
            makeEvent({
                paramName: INTERNAL_PARAM,
                routeId: `/api/continue-watching/[${INTERNAL_PARAM}]`,
                path: `/api/continue-watching/${MEDIA_ID}`,
                authenticated: true,
            }),
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ cleared: true, itemId: MEDIA_ID });
    });

    it('rejects an unauthenticated caller without touching watch state', async () => {
        const res = await v1Route.DELETE!(
            makeEvent({
                paramName: V1_PARAM,
                routeId: `/api/v1/continue-watching/[${V1_PARAM}]`,
                path: `/api/v1/continue-watching/${MEDIA_ID}`,
                authenticated: false,
            }),
        );

        expect(res.status).toBe(401);
        expect(mockClearWatchProgress).not.toHaveBeenCalled();
    });
});
