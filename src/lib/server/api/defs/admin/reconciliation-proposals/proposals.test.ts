// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The apply and dismiss endpoints map the service's refusals to HTTP: an unknown
 * proposal is a 404, a resolved or stale one a 409, and anything unexpected is
 * rethrown (a 500) rather than disguised as a conflict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

class MockProposalError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}
const applyAbsoluteNumberingProposal = vi.fn();
const dismissAbsoluteNumberingProposal = vi.fn();
vi.mock('$lib/server/services/absolute-numbering-reconciliation.service.js', () => ({
    ProposalActionError: MockProposalError,
    applyAbsoluteNumberingProposal,
    dismissAbsoluteNumberingProposal,
}));

const { def: applyDef } = await import('./apply.js');
const { def: dismissDef } = await import('./dismiss.js');

const ID = '00000000-0000-4000-a000-000000000001';

function call(def: typeof applyDef | typeof dismissDef) {
    const event = { locals: { user: { username: 'admin-user' } } } as unknown as RequestEvent;
    return def.handlers.POST!(event, { input: { params: { quarantineId: ID } } } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/admin/reconciliation-proposals/{quarantineId}/apply', () => {
    it('returns the new position and records the admin as the resolver', async () => {
        const applied = {
            quarantineId: ID,
            moveId: 'm1',
            episodeId: 'e1',
            seasonNumber: 13,
            episodeNumber: 422,
        };
        applyAbsoluteNumberingProposal.mockResolvedValue(applied);

        const res = await call(applyDef);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(applied);
        expect(applyAbsoluteNumberingProposal).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            'admin-user',
        );
    });

    it('answers 404 for an unknown proposal', async () => {
        applyAbsoluteNumberingProposal.mockRejectedValue(new MockProposalError('not-found', 'x'));
        expect((await call(applyDef)).status).toBe(404);
    });

    it.each(['stale', 'already-resolved'])('answers 409 for %s', async (code) => {
        applyAbsoluteNumberingProposal.mockRejectedValue(
            new MockProposalError(code, 'The proposed target episode has a file now'),
        );
        const res = await call(applyDef);
        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain('has a file now');
    });

    it('rethrows an unexpected failure', async () => {
        applyAbsoluteNumberingProposal.mockRejectedValue(new Error('db down'));
        await expect(call(applyDef)).rejects.toThrow('db down');
    });
});

describe('POST /api/admin/reconciliation-proposals/{quarantineId}/dismiss', () => {
    it('dismisses and records the admin as the resolver', async () => {
        dismissAbsoluteNumberingProposal.mockResolvedValue(undefined);

        const res = await call(dismissDef);

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ quarantineId: ID });
        expect(dismissAbsoluteNumberingProposal).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            'admin-user',
        );
    });

    it('records a token caller by its own name', async () => {
        dismissAbsoluteNumberingProposal.mockResolvedValue(undefined);
        applyAbsoluteNumberingProposal.mockResolvedValue({});
        const event = {
            locals: { principal: { username: 'service:ci-bot', kind: 'service' } },
        } as unknown as RequestEvent;
        const input = { input: { params: { quarantineId: ID } } } as never;

        await dismissDef.handlers.POST!(event, input);
        await applyDef.handlers.POST!(event, input);

        expect(dismissAbsoluteNumberingProposal).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            'service:ci-bot',
        );
        expect(applyAbsoluteNumberingProposal).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            'service:ci-bot',
        );
    });

    it('answers 404 for an unknown proposal and 409 for a resolved one', async () => {
        dismissAbsoluteNumberingProposal.mockRejectedValueOnce(
            new MockProposalError('not-found', 'x'),
        );
        expect((await call(dismissDef)).status).toBe(404);
        dismissAbsoluteNumberingProposal.mockRejectedValueOnce(
            new MockProposalError('already-resolved', 'x'),
        );
        expect((await call(dismissDef)).status).toBe(409);
    });
});
