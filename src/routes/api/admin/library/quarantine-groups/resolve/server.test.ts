// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    recheck: vi.fn(),
    accept: vi.fn(),
    currentMatch: vi.fn(),
    dismiss: vi.fn(),
    restore: vi.fn(),
    db: {},
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => mocks.db }));
vi.mock('$lib/server/services/episode-reconciliation.service.js', () => ({
    recheckQuarantinedMatchesForSeries: mocks.recheck,
    acceptQuarantinedMatchesForSeries: mocks.accept,
    confirmQuarantinedCurrentMatchesForSeries: mocks.currentMatch,
}));
vi.mock('$lib/server/services/quarantine-inspection.service.js', () => ({
    hideQuarantineGroup: mocks.dismiss,
    showQuarantineWarningsAgain: mocks.restore,
}));
import { POST } from './+server.js';
import { QuarantineGroupResolveResponseSchema } from '$lib/schemas/api-admin-library-responses.js';
const seriesId = '12345678-1234-4234-8234-123456789abc';
const after = '12345678-1234-4234-8234-123456789abd';
interface Identity {
    username?: string;
    isAdmin: boolean;
    scopes: string[];
}
async function request(
    body: unknown,
    identity: Identity | null = {
        username: 'real-admin',
        isAdmin: true,
        scopes: ['library:admin'],
    },
): Promise<Response> {
    const url = new URL('http://test/api/admin/library/quarantine-groups/resolve');
    return POST!({
        url,
        params: {},
        route: { id: '/api/admin/library/quarantine-groups/resolve' },
        locals: {
            principal: identity
                ? { kind: 'session', userId: seriesId, userGroups: [], ...identity }
                : undefined,
        },
        request: new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
    } as never);
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.recheck.mockResolvedValue({
        examined: 250,
        resolved: 20,
        retained: 230,
        continuation: after,
    });
    mocks.currentMatch.mockResolvedValue({
        examined: 1,
        resolved: 0,
        retained: 1,
        review: [],
        reviewedPage: { ids: [seriesId], fingerprint: 'a'.repeat(64) },
    });
});
describe('mounted quarantine recheck endpoint', () => {
    it('previews and confirms only a reviewed current match with authenticated attribution', async () => {
        const preview = await request({ action: 'preview-current-match', seriesId, limit: 1 });
        expect(preview.status).toBe(200);
        expect(mocks.currentMatch).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', {
            after: undefined,
            limit: 1,
            reviewed: undefined,
            reviewedPage: undefined,
            preview: true,
        });
        expect(await preview.json()).toMatchObject({
            action: 'preview-current-match',
            currentMatchReview: [],
        });
        const reviewed = [{ id: seriesId, fingerprint: 'b'.repeat(64) }];
        const reviewedPage = { ids: [seriesId], fingerprint: 'a'.repeat(64) };
        mocks.currentMatch.mockResolvedValueOnce({ examined: 1, resolved: 1, retained: 0 });
        const confirm = await request({
            action: 'confirm-current-match',
            seriesId,
            reviewed,
            reviewedPage,
        });
        expect(confirm.status).toBe(200);
        expect(mocks.currentMatch).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', {
            after: undefined,
            limit: undefined,
            reviewed,
            reviewedPage,
            preview: false,
        });
        expect(await confirm.json()).toMatchObject({
            action: 'confirm-current-match',
            resolved: 1,
        });
    });
    it('requires a reviewed selection and admin scope for current-match confirmation', async () => {
        expect((await request({ action: 'confirm-current-match', seriesId })).status).toBe(422);
        expect(
            (await request({ action: 'preview-current-match', parentTmdbId: '123' })).status,
        ).toBe(422);
        expect((await request({ action: 'preview-current-match', seriesId }, null)).status).toBe(
            401,
        );
        expect(
            (
                await request(
                    { action: 'preview-current-match', seriesId },
                    {
                        username: 'viewer',
                        isAdmin: false,
                        scopes: ['read'],
                    },
                )
            ).status,
        ).toBe(403);
        expect(mocks.currentMatch).not.toHaveBeenCalled();
    });
    it('uses the authenticated actor and returns bounded continuation and truthful totals', async () => {
        const res = await request({ action: 'recheck', seriesId, after, limit: 250 });
        expect(res.status).toBe(200);
        expect(mocks.recheck).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', {
            after,
            limit: 250,
        });
        expect(await res.json()).toEqual({
            action: 'recheck',
            examined: 250,
            resolved: 20,
            retained: 230,
            continuation: after,
        });
    });
    it.each([
        { action: 'recheck', seriesId, resolvedBy: 'forged' },
        { action: 'recheck', seriesId, after: 'bad' },
        { action: 'recheck', seriesId, limit: 1001 },
        { action: 'recheck', seriesId: 'bad' },
        { action: 'recheck', parentTmdbId: '123' },
        { action: 'recheck', seriesId, parentTmdbId: '123' },
    ])('rejects malformed or actor-supplied requests: %j', async (body) => {
        const res = await request(body);
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(mocks.recheck).not.toHaveBeenCalled();
    });
    it('mounts Accept with authenticated attribution and continuation forwarding', async () => {
        mocks.accept.mockResolvedValue({
            accepted: 1,
            appliedExternalIds: 1,
            updatedTitles: 1,
            skipped: 249,
            examined: 250,
            continuation: after,
        });
        const reviewed = [{ id: after, fingerprint: 'a'.repeat(64) }];
        const reviewedPage = { ids: [after], fingerprint: 'b'.repeat(64) };
        const response = await request({
            action: 'accept',
            seriesId,
            after,
            limit: 250,
            reviewed,
            reviewedPage,
        });
        expect(response.status).toBe(200);
        expect(mocks.accept).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', {
            after,
            limit: 250,
            reviewed,
            reviewedPage,
            preview: false,
        });
        expect(await response.json()).toMatchObject({
            action: 'accept',
            resolved: 1,
            skipped: 249,
            continuation: after,
        });
    });
    it('requires an explicit reviewed batch for Accept and supports a no-write preview', async () => {
        expect((await request({ action: 'accept', seriesId })).status).toBe(422);
        expect(mocks.accept).not.toHaveBeenCalled();
        mocks.accept.mockResolvedValue({
            accepted: 0,
            appliedExternalIds: 0,
            updatedTitles: 0,
            skipped: 0,
            review: [],
        });
        expect((await request({ action: 'preview-accept', seriesId })).status).toBe(200);
        expect(mocks.accept).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', {
            after: undefined,
            limit: undefined,
            reviewed: undefined,
            reviewedPage: undefined,
            preview: true,
        });
    });
    it('rejects anonymous requests', async () => {
        expect((await request({ action: 'recheck', seriesId }, null)).status).toBe(401);
        expect(mocks.recheck).not.toHaveBeenCalled();
    });
    it('rejects a user without library admin scope', async () => {
        expect(
            (
                await request(
                    { action: 'recheck', seriesId },
                    { username: 'reader', isAdmin: false, scopes: ['read'] },
                )
            ).status,
        ).toBe(403);
        expect(mocks.recheck).not.toHaveBeenCalled();
    });
    it('does not invent an actor for an identity missing its username', async () => {
        expect(
            (
                await request(
                    { action: 'recheck', seriesId },
                    { isAdmin: true, scopes: ['library:admin'] },
                )
            ).status,
        ).toBe(401);
        expect(mocks.recheck).not.toHaveBeenCalled();
    });
    it('rejects malformed or inconsistent recheck result totals in the typed client contract', () => {
        for (const result of [
            { action: 'recheck', resolved: 1 },
            { action: 'recheck', examined: 1, resolved: 1, retained: 1 },
            { action: 'recheck', examined: 1, resolved: -1, retained: 2 },
        ])
            expect(QuarantineGroupResolveResponseSchema.safeParse(result).success).toBe(false);
    });
    it('reports a rejected operation as an error', async () => {
        mocks.recheck.mockRejectedValue(new Error('Interrupted'));
        expect((await request({ action: 'recheck', seriesId })).status).toBe(500);
    });
    const totals = {
        resolved: 0,
        examined: 0,
        blocked: 0,
        skipped: 0,
        appliedExternalIds: 0,
        updatedTitles: 0,
    };
    const page = { ids: [], fingerprint: 'a'.repeat(64) };
    const preview = {
        action: 'preview-accept',
        ...totals,
        review: [],
        blockedReview: [],
        reviewedPage: page,
    };
    it('rejects incomplete, negative and incoherent accept/preview response contracts', () => {
        for (const action of ['accept', 'preview-accept']) {
            const valid = action === 'accept' ? { action, ...totals } : preview;
            for (const key of [
                'examined',
                'blocked',
                'skipped',
                'appliedExternalIds',
                'updatedTitles',
            ]) {
                const missing = { ...valid } as Record<string, unknown>;
                delete missing[key];
                expect(QuarantineGroupResolveResponseSchema.safeParse(missing).success).toBe(false);
                expect(
                    QuarantineGroupResolveResponseSchema.safeParse({ ...valid, [key]: -1 }).success,
                ).toBe(false);
            }
            expect(
                QuarantineGroupResolveResponseSchema.safeParse({ ...valid, resolved: -1 }).success,
            ).toBe(false);
            expect(
                QuarantineGroupResolveResponseSchema.safeParse({ ...valid, examined: 1 }).success,
            ).toBe(false);
        }
        for (const key of ['review', 'reviewedPage', 'blockedReview']) {
            const missing = { ...preview } as Record<string, unknown>;
            delete missing[key];
            expect(QuarantineGroupResolveResponseSchema.safeParse(missing).success).toBe(false);
        }
        for (const invalid of [
            { action: 'accept', ...totals, resolved: 1, examined: 1 },
            { action: 'accept', ...totals, appliedExternalIds: 1 },
            { action: 'accept', ...totals, updatedTitles: 1 },
            { ...preview, blocked: 1, examined: 1 },
            { ...preview, resolved: 1 },
            { action: 'accept', ...totals, pageChanged: true, continuation: after },
            { action: 'preview-accept', ...totals, pageChanged: true, examined: 1 },
        ])
            expect(QuarantineGroupResolveResponseSchema.safeParse(invalid).success).toBe(false);
    });
    it('preserves legacy dismiss and empty, retained, expanded dependency and changed-page handler shapes', async () => {
        const decision = {
            id: seriesId,
            fingerprint: 'b'.repeat(64),
            episodeId: seriesId,
            currentTitle: 'Before',
            currentTmdbEpisodeId: '1',
            title: 'After',
            tmdbEpisodeId: '2',
            overview: null,
            stillPath: null,
            seasonNumber: 1,
            episodeNumber: 1,
        };
        const retained = { episodeId: after, title: 'Retained', target: '3', reason: 'ineligible' };
        const shapes = [
            { action: 'dismiss', resolved: 2 },
            { action: 'accept', ...totals },
            preview,
            {
                action: 'accept',
                ...totals,
                examined: 3,
                resolved: 1,
                skipped: 1,
                blocked: 1,
                appliedExternalIds: 1,
                updatedTitles: 1,
            },
            { ...preview, examined: 1, blocked: 1, blockedReview: [retained] },
            {
                ...preview,
                examined: 2,
                review: [decision, { ...decision, id: after, episodeId: after }],
                reviewedPage: { ...page, ids: [seriesId] },
            },
            ...['accept', 'preview-accept'].map((action) => ({
                action,
                ...totals,
                pageChanged: true,
            })),
        ];
        for (const shape of shapes) {
            expect(QuarantineGroupResolveResponseSchema.safeParse(shape).success).toBe(true);
            if (shape.action === 'dismiss')
                mocks.dismiss.mockResolvedValue({ resolved: shape.resolved, batchId: seriesId });
            else mocks.accept.mockResolvedValue({ ...shape, accepted: shape.resolved });
            const res = await request({
                action: shape.action,
                seriesId,
                ...(shape.action === 'dismiss' ? { groupFingerprint: 'd'.repeat(32) } : {}),
                ...(shape.action === 'accept' ? { reviewed: [], reviewedPage: page } : {}),
            });
            expect(res.status).toBe(200);
            expect(QuarantineGroupResolveResponseSchema.safeParse(await res.json()).success).toBe(
                true,
            );
        }
    });
});

describe('warning visibility authority', () => {
    it('requires the current group fingerprint and refuses stale hide authority', async () => {
        expect((await request({ action: 'dismiss', seriesId })).status).toBe(422);
        mocks.dismiss.mockResolvedValueOnce(null);
        expect(
            (
                await request({
                    action: 'dismiss',
                    groupKey: 'unknown',
                    groupFingerprint: 'd'.repeat(32),
                })
            ).status,
        ).toBe(409);
        expect(mocks.dismiss).toHaveBeenCalledWith(
            mocks.db,
            'unknown',
            'd'.repeat(32),
            'real-admin',
        );
    });
    it('restores only a receipt batch, validates input and requires admin scope', async () => {
        mocks.restore.mockResolvedValue({ restored: 2, changed: 1, continuation: after });
        const res = await request({ action: 'restore', batchId: seriesId });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            action: 'restore',
            resolved: 0,
            restored: 2,
            changed: 1,
            continuation: after,
        });
        expect(mocks.restore).toHaveBeenCalledWith(mocks.db, seriesId, 'real-admin', undefined);
        expect((await request({ action: 'restore' })).status).toBe(422);
        expect((await request({ action: 'restore', batchId: seriesId, seriesId })).status).toBe(
            422,
        );
        expect((await request({ action: 'restore', batchId: seriesId }, null)).status).toBe(401);
    });
});
