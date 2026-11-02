// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({ dismiss: vi.fn(), legacy: vi.fn(), audit: vi.fn() }));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/services/quarantine-inspection.service.js', () => ({
    dismissReviewedQuarantine: seam.dismiss,
}));
vi.mock('$lib/server/database/queries/sync-quarantine.queries.js', () => ({
    resolveQuarantine: seam.legacy,
}));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditActor: () => ({ username: 'authenticated-admin' }),
    auditLog: seam.audit,
}));
import { POST } from './+server.js';
const id = '12345678-1234-4234-8234-123456789abc';
function event(body: unknown, admin = true): Parameters<NonNullable<typeof POST>>[0] {
    const url = new URL(`http://localhost/api/admin/quarantine/${id}/resolve`);
    return {
        url,
        params: { id },
        locals: {
            user: { username: 'authenticated-admin', ownerIsAdmin: admin },
            principal: {
                kind: 'session',
                username: 'authenticated-admin',
                isAdmin: admin,
                scopes: admin ? ['admin'] : [],
            },
        },
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    } as never;
}
beforeEach(() => {
    vi.clearAllMocks();
    seam.dismiss.mockResolvedValue(true);
});
describe('reviewed individual rejection', () => {
    it('resolves exactly one fingerprint with authenticated attribution and an audit event', async () => {
        const response = await POST!(
            event({ resolution: 'dismissed', fingerprint: 'a'.repeat(64) }),
        );
        expect(response.status).toBe(200);
        expect(seam.dismiss).toHaveBeenCalledWith(
            expect.anything(),
            id,
            'a'.repeat(64),
            'authenticated-admin',
        );
        expect(seam.legacy).not.toHaveBeenCalled();
        expect(seam.audit).toHaveBeenCalledOnce();
    });
    it('returns conflict for stale/revived/current-state changes without falling back to the legacy writer', async () => {
        seam.dismiss.mockResolvedValue(false);
        expect(
            (await POST!(event({ resolution: 'dismissed', fingerprint: 'a'.repeat(64) }))).status,
        ).toBe(409);
        expect(seam.legacy).not.toHaveBeenCalled();
        expect(seam.audit).not.toHaveBeenCalled();
    });
    it('rejects malformed review authority and forged actor fields', async () => {
        expect((await POST!(event({ resolution: 'dismissed', fingerprint: 'bad' }))).status).toBe(
            422,
        );
        expect(
            (
                await POST!(
                    event({
                        resolution: 'dismissed',
                        fingerprint: 'a'.repeat(64),
                        resolvedBy: 'forged',
                    }),
                )
            ).status,
        ).toBe(422);
        expect(seam.dismiss).not.toHaveBeenCalled();
    });
    it('requires administrative authorization even when addressed directly', async () => {
        expect(
            (await POST!(event({ resolution: 'dismissed', fingerprint: 'a'.repeat(64) }, false)))
                .status,
        ).toBe(403);
        expect(seam.dismiss).not.toHaveBeenCalled();
    });
});
