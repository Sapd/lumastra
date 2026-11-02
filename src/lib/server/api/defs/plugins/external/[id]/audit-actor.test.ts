// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audit-actor coverage for the eight external-plugin lifecycle defs (fix
 * round 1, security review 2026-09-13, R5 follow-through).
 *
 * All eight share ONE handler shape (v1 `defs/plugins/external/[id]/*` and
 * the internal cookie-auth twin `defs/admin/plugins/external/[id]/*`, each
 * across enable/disable/reload/uninstall):
 *
 *     const actor = auditActor(event);
 *     const r = await <lifecycle>ExternalPlugin(sql, id, actor);
 *
 * Before commit 907742bc0 every one of these flattened
 * `event.locals.principal` down to a bare username string BEFORE calling the
 * service, so a PAT/service-token caller's `plugin.external.*` audit row
 * always wrote `principalKind`/`credentialId` as NULL. That commit fixed the
 * code but only pinned ONE of ten migrated call sites with a behavioural
 * test (`admin/plugins/external/install.test.ts`) — these eight `[id]` defs
 * were unpinned: a future edit reverting the `const actor = ...` line back
 * to a flattened username would compile fine and produce a NULL-`kind` audit
 * row with nothing going red. This file closes that gap with one
 * parameterised test over the shared shape.
 *
 * Discrimination check performed by hand while writing this file (not
 * committed): temporarily reverted `[id]/enable.ts`'s `const actor =
 * auditActor(event);` back to
 * `event.locals.principal?.username ?? event.locals.user?.username ?? null`
 * — only the "v1 enable" case below went red (received `"alice"` instead of
 * the full object), the other seven stayed green, confirming each
 * parameterised case actually exercises its own def file rather than
 * silently passing regardless of what that file does. Restored afterward;
 * `git status` / `git diff` show no trace of the temporary revert.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockEnable = vi.fn();
const mockDisable = vi.fn();
const mockReload = vi.fn();
const mockUninstall = vi.fn();
vi.mock('$lib/server/services/external-plugin-manager.service.js', () => ({
    enableExternalPlugin: (...a: unknown[]) => mockEnable(...a),
    disableExternalPlugin: (...a: unknown[]) => mockDisable(...a),
    reloadExternalPlugin: (...a: unknown[]) => mockReload(...a),
    uninstallExternalPlugin: (...a: unknown[]) => mockUninstall(...a),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const { def: v1Enable } = await import('./enable.js');
const { def: v1Disable } = await import('./disable.js');
const { def: v1Reload } = await import('./reload.js');
const { def: v1Uninstall } = await import('./uninstall.js');
const { def: adminEnable } = await import('../../../admin/plugins/external/[id]/enable.js');
const { def: adminDisable } = await import('../../../admin/plugins/external/[id]/disable.js');
const { def: adminReload } = await import('../../../admin/plugins/external/[id]/reload.js');
const { def: adminUninstall } = await import('../../../admin/plugins/external/[id]/uninstall.js');

function makeEvent(locals: Record<string, unknown>): RequestEvent {
    return {
        params: { id: 'sample-plugin' },
        locals,
    } as unknown as RequestEvent;
}

const PRINCIPAL_ACTOR = { username: 'alice', kind: 'pat' as const, credentialId: 'pat-1' };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({} as never);
    mockEnable.mockResolvedValue({ status: 200, body: {} });
    mockDisable.mockResolvedValue({ status: 200, body: {} });
    mockReload.mockResolvedValue({ status: 200, body: {} });
    mockUninstall.mockResolvedValue({ status: 200, body: {} });
});

const CASES: Array<[string, { handlers: { POST?: unknown } }, () => ReturnType<typeof vi.fn>]> = [
    ['v1 enable', v1Enable, () => mockEnable],
    ['v1 disable', v1Disable, () => mockDisable],
    ['v1 reload', v1Reload, () => mockReload],
    ['v1 uninstall', v1Uninstall, () => mockUninstall],
    ['admin enable', adminEnable, () => mockEnable],
    ['admin disable', adminDisable, () => mockDisable],
    ['admin reload', adminReload, () => mockReload],
    ['admin uninstall', adminUninstall, () => mockUninstall],
];

describe.each(CASES)('%s def — audit actor', (_name, def, serviceMock) => {
    it('passes the request Principal (kind + credentialId), not a flattened username', async () => {
        const event = makeEvent({
            principal: { username: 'alice', kind: 'pat', credentialId: 'pat-1', isAdmin: true },
        });

        const post = def.handlers.POST as (event: RequestEvent, ctx: unknown) => Promise<Response>;
        await post(event, {} as never);

        expect(serviceMock()).toHaveBeenCalledWith(
            expect.anything(),
            'sample-plugin',
            PRINCIPAL_ACTOR,
        );
    });

    it('passes a null-username actor when no identity resolved', async () => {
        const event = makeEvent({});

        const post = def.handlers.POST as (event: RequestEvent, ctx: unknown) => Promise<Response>;
        await post(event, {} as never);

        expect(serviceMock()).toHaveBeenCalledWith(expect.anything(), 'sample-plugin', {
            username: null,
        });
    });
});
