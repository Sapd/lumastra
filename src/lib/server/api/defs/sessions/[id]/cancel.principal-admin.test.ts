// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /play-sessions/{id} — cancelling another user's session needs an
 * admin PRINCIPAL (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';
import { TEST_USER_ID } from '$lib/server/api/principal-locals.test-helpers.js';

const mockGetSessionById = vi.fn();
const mockKillSessionUnified = vi.fn();

vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: (...a: unknown[]) => mockGetSessionById(...a),
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    killSessionUnified: (...a: unknown[]) => mockKillSessionUnified(...a),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: vi.fn() };
});

import { cancellationDef as def } from '../../play-sessions/_cancellation.js';

async function invoke(locals: RequestEvent['locals']): Promise<Response> {
    return def.handlers.DELETE!({ params: { id: SESSION_ID }, locals } as unknown as RequestEvent, {
        surface: 'v1',
    });
}

const SESSION_ID = '5b0c1c2e-6a8f-4d7e-9b1a-2f3c4d5e6f70';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
    vi.clearAllMocks();
    mockKillSessionUnified.mockResolvedValue({ killed: true, source: 'database', username: 'bob' });
});

describe('cancelling another user’s session', () => {
    beforeEach(() => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: OTHER_USER_ID });
    });

    it('an admin owner’s device token gets 404 and kills nothing', async () => {
        expect((await invoke(adminOwnersDeviceToken())).status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('a principal-less request with locals.user.isAdmin gets 404 and kills nothing', async () => {
        expect((await invoke(adminUserWithoutPrincipal())).status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('control: an admin session gets 204 and kills it', async () => {
        expect((await invoke(adminSession())).status).toBe(204);
        expect(mockKillSessionUnified).toHaveBeenCalledOnce();
    });

    it('the owner can still cancel their own session with a device token', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: TEST_USER_ID });
        expect((await invoke(adminOwnersDeviceToken())).status).toBe(204);
    });
});
