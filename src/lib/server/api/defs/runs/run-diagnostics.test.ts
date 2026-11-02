// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Exposure contract for `task_history.error.stack`.
 *
 * The shared `defs/runs/[id].ts` def is dual-mounted (`/api/runs/{id}` AND
 * `/api/v1/runs/{id}`) behind `auth: {kind:'scope', anyOf:['runs:read']}`.
 * `runs:read` is granted by the coarse `read` alias (expandScopes), and
 * `buildPrincipal` hands every NON-admin session `['read','write']` — so that
 * def is reachable by any logged-in user and by any `read`-scoped PAT. Its
 * stack redaction therefore MUST stay in place on both surfaces.
 *
 * The stack is instead served by the separate `defs/runs/[id]/diagnostics.ts`
 * def, gated on `auth: {kind:'admin'}` — which `enforce()` evaluates from
 * `locals.principal.isAdmin` alone, identically on both surfaces.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetRun = vi.fn();
const mockGetDb = vi.fn();
const mockGetEnabledLibraryPaths = vi.fn();

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        getRun: (...args: unknown[]) => mockGetRun(...args),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: (...args: unknown[]) => mockGetEnabledLibraryPaths(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_TRANSCODE_DIR: '/tmp/transcode' },
    features: {},
}));

const { def: runDef } = await import('./[id].js');
const { def: diagnosticsDef } = await import('./[id]/diagnostics.js');
const { mount } = await import('$lib/server/api/mount.js');

const RUN_ID = '11111111-2222-3333-4444-555555555555';
const STACK = 'Error: boom\n    at scan (/data/movies/Private/leak.mkv:1:1)';

function makeEvent(opts: { isAdmin: boolean; scopes: string[] }): RequestEvent {
    const url = new URL(`http://localhost/api/runs/${RUN_ID}`);
    return {
        url,
        params: { id: RUN_ID },
        route: { id: '/api/runs/[id]' as const },
        request: new Request(url.toString()),
        locals: {
            principal: {
                kind: 'session',
                userId: 'usr_1',
                username: 'alice',
                userGroups: [],
                scopes: opts.scopes,
                isAdmin: opts.isAdmin,
            },
            user: {
                userId: 'usr_1',
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: opts.isAdmin,
                maxAgeRating: null,
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

// A plain logged-in NON-admin session: buildPrincipal gives ['read','write'],
// which expandScopes turns into a set containing runs:read.
const nonAdmin = { isAdmin: false, scopes: ['read', 'write', 'runs:read', 'tasks:read'] };
const admin = { isAdmin: true, scopes: ['admin', 'read', 'write', 'runs:read'] };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetEnabledLibraryPaths.mockResolvedValue([{ path: '/data/movies' }]);
    mockGetRun.mockResolvedValue({
        id: RUN_ID,
        taskId: 'file-library-scan',
        label: 'File Library Scan',
        state: 'failed',
        input: { libraryPathId: 'lp-1' },
        trigger: { kind: 'scheduled' },
        actor: { type: 'system' },
        startedAt: '2026-08-06T10:00:00.000Z',
        stages: [],
        error: { message: 'boom', kind: 'permanent', stack: STACK },
    });
});

describe('GET /runs/{id} — shared def keeps stripping error.stack', () => {
    for (const surface of ['internal', 'v1'] as const) {
        it(`strips the stack for a non-admin caller on the ${surface} surface`, async () => {
            const handlers = mount(runDef, { surface });
            const res = await handlers.GET!(makeEvent(nonAdmin));
            expect(res.status).toBe(200);
            const body = (await res.json()) as { error?: Record<string, unknown> };
            expect(body.error?.message).toBe('boom');
            expect(body.error?.stack).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain('leak.mkv');
        });

        it(`still exposes task_history.input on the ${surface} surface`, async () => {
            const handlers = mount(runDef, { surface });
            const res = await handlers.GET!(makeEvent(nonAdmin));
            const body = (await res.json()) as { input?: Record<string, unknown> };
            expect(body.input).toEqual({ libraryPathId: 'lp-1' });
        });
    }
});

describe('GET /runs/{id}/diagnostics — admin-only stack exposure', () => {
    for (const surface of ['internal', 'v1'] as const) {
        it(`returns the real stack to an admin on the ${surface} surface`, async () => {
            const handlers = mount(diagnosticsDef, { surface });
            const res = await handlers.GET!(makeEvent(admin));
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                runId: string;
                error: { message: string; kind?: string; stack?: string } | null;
                redaction: { libraryRoots: string[]; transcodeRoot?: string };
            };
            expect(body.runId).toBe(RUN_ID);
            expect(body.error?.stack).toBe(STACK);
            expect(body.error?.message).toBe('boom');
            expect(body.redaction.libraryRoots).toEqual(['/data/movies']);
            expect(body.redaction.transcodeRoot).toBe('/tmp/transcode');
        });

        it(`rejects a non-admin caller with 403 on the ${surface} surface`, async () => {
            const handlers = mount(diagnosticsDef, { surface });
            const res = await handlers.GET!(makeEvent(nonAdmin));
            expect(res.status).toBe(403);
            expect(await res.text()).not.toContain('leak.mkv');
        });
    }

    it('returns error: null for a run that has no recorded error', async () => {
        mockGetRun.mockResolvedValue({
            id: RUN_ID,
            taskId: 'file-library-scan',
            label: 'x',
            state: 'completed',
            trigger: { kind: 'scheduled' },
            actor: { type: 'system' },
            startedAt: '2026-08-06T10:00:00.000Z',
            stages: [],
        });
        const handlers = mount(diagnosticsDef, { surface: 'internal' });
        const res = await handlers.GET!(makeEvent(admin));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { error: unknown };
        expect(body.error).toBeNull();
    });

    it('404s an unknown run', async () => {
        mockGetRun.mockResolvedValue(null);
        const handlers = mount(diagnosticsDef, { surface: 'internal' });
        const res = await handlers.GET!(makeEvent(admin));
        expect(res.status).toBe(404);
    });
});
