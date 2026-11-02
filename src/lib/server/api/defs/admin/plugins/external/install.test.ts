// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/plugins/external/install — audit-actor attribution (R5).
 *
 * Before this fix, the handler flattened the caller's identity to a bare
 * username string (`event.locals.principal?.username ?? event.locals.user
 * ?.username ?? null`) before it ever reached `installExternalPlugin()` —
 * discarding the credential kind/id `event.locals.principal` already carries.
 * `installer.ts`'s `auditLog('plugin.external.install', ...)` call therefore
 * always wrote `principalKind`/`credentialId` as NULL for this endpoint,
 * regardless of whether the caller authenticated via a PAT, a service token,
 * or a session — the exact attribution gap R5 exists to close.
 *
 * This test drives the actual handler (not just its declared schema, which
 * is all `install.test.ts` in the v1-surface twin directory covers) and
 * asserts the object `installExternalPlugin()` receives as `actor` is the
 * full `auditActor(event)` result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockInstallExternalPlugin = vi.fn();
vi.mock('$lib/server/services/external-plugin-manager.service.js', () => ({
    installExternalPlugin: (...args: unknown[]) => mockInstallExternalPlugin(...args),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const { def } = await import('./install.js');

function makeEvent(locals: Record<string, unknown>): RequestEvent {
    return {
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify({ manifestUrl: 'https://example.com/m.json', signature: 'sig' }),
        }),
        locals,
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({} as never);
    mockInstallExternalPlugin.mockResolvedValue({ status: 201, body: {} });
});

describe('POST /admin/plugins/external/install — audit actor', () => {
    it('passes the full Principal-derived actor, not a flattened username', async () => {
        const event = makeEvent({
            principal: { username: 'alice', kind: 'pat', credentialId: 'pat-1', isAdmin: true },
        });

        await def.handlers.POST!(event, {} as never);

        expect(mockInstallExternalPlugin).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { username: 'alice', kind: 'pat', credentialId: 'pat-1' },
        );
    });

    it('falls back to a null-username actor when no identity resolved', async () => {
        const event = makeEvent({});

        await def.handlers.POST!(event, {} as never);

        expect(mockInstallExternalPlugin).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            { username: null },
        );
    });
});
