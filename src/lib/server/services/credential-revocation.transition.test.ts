// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `applyAdminStatusTransition()` — the ONE shared
 * narrow/restore entry point every admin-affecting write should call
 * (security review 2026-09-23, final fix wave, X1(b)/X3). Verifies the three
 * branches (demote, promote, no-op) and that it delegates to the EXISTING
 * `narrowAdminScopedCredentialsForUser` / `restoreAdminScopedCredentialsForUser`
 * fan-outs rather than reimplementing them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPatMarkNarrow, mockPatClearNarrow, mockSvcMarkNarrow, mockSvcClearNarrow } = vi.hoisted(
    () => ({
        mockPatMarkNarrow: vi.fn(),
        mockPatClearNarrow: vi.fn(),
        mockSvcMarkNarrow: vi.fn(),
        mockSvcClearNarrow: vi.fn(),
    }),
);

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({
        markAdminScopedForceNonAdminForUser: (...a: unknown[]) => mockPatMarkNarrow(...a),
        clearForceNonAdminForUser: (...a: unknown[]) => mockPatClearNarrow(...a),
    }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({
        markAdminScopedForceNonAdminImpersonating: (...a: unknown[]) => mockSvcMarkNarrow(...a),
        clearForceNonAdminForUserAndCreator: (...a: unknown[]) => mockSvcClearNarrow(...a),
    }),
}));

import { applyAdminStatusTransition } from './credential-revocation.service.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const USERNAME = 'alice';
const sqlStub = {} as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockPatMarkNarrow.mockResolvedValue(1);
    mockPatClearNarrow.mockResolvedValue(1);
    mockSvcMarkNarrow.mockResolvedValue(1);
    mockSvcClearNarrow.mockResolvedValue(1);
});

describe('applyAdminStatusTransition', () => {
    it('true -> false: narrows (delegates to narrowAdminScopedCredentialsForUser)', async () => {
        const result = await applyAdminStatusTransition(sqlStub, USER_ID, USERNAME, true, false);
        expect(mockPatMarkNarrow).toHaveBeenCalledTimes(1);
        expect(mockSvcMarkNarrow).toHaveBeenCalledTimes(1);
        expect(mockPatClearNarrow).not.toHaveBeenCalled();
        expect(mockSvcClearNarrow).not.toHaveBeenCalled();
        expect(result.failedStores).toEqual([]);
    });

    it('false -> true: restores (delegates to restoreAdminScopedCredentialsForUser)', async () => {
        const result = await applyAdminStatusTransition(sqlStub, USER_ID, USERNAME, false, true);
        expect(mockPatClearNarrow).toHaveBeenCalledTimes(1);
        expect(mockSvcClearNarrow).toHaveBeenCalledTimes(1);
        expect(mockPatMarkNarrow).not.toHaveBeenCalled();
        expect(mockSvcMarkNarrow).not.toHaveBeenCalled();
        expect(result.failedStores).toEqual([]);
    });

    it('true -> true: no-op, neither narrow nor restore called', async () => {
        await applyAdminStatusTransition(sqlStub, USER_ID, USERNAME, true, true);
        expect(mockPatMarkNarrow).not.toHaveBeenCalled();
        expect(mockPatClearNarrow).not.toHaveBeenCalled();
        expect(mockSvcMarkNarrow).not.toHaveBeenCalled();
        expect(mockSvcClearNarrow).not.toHaveBeenCalled();
    });

    it('false -> false: no-op, neither narrow nor restore called', async () => {
        await applyAdminStatusTransition(sqlStub, USER_ID, USERNAME, false, false);
        expect(mockPatMarkNarrow).not.toHaveBeenCalled();
        expect(mockPatClearNarrow).not.toHaveBeenCalled();
        expect(mockSvcMarkNarrow).not.toHaveBeenCalled();
        expect(mockSvcClearNarrow).not.toHaveBeenCalled();
    });

    it('surfaces failedStores from the delegated fan-out', async () => {
        mockPatMarkNarrow.mockRejectedValue(new Error('db down'));
        const result = await applyAdminStatusTransition(sqlStub, USER_ID, USERNAME, true, false);
        expect(result.failedStores).toContain('pats');
    });
});
