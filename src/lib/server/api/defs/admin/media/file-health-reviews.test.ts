// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminSession,
    adminOwnersReadWritePat,
} from '$lib/server/api/principal-locals.test-helpers.js';
const mocks = vi.hoisted(() => ({ db: vi.fn(), preview: vi.fn(), write: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mocks.db }));
vi.mock('$lib/server/services/file-health-review.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/file-health-review.service.js')>()),
    previewFileHealthReview: mocks.preview,
    writeFileHealthReview: mocks.write,
}));
import { FileHealthReviewError } from '$lib/server/services/file-health-review.service.js';
import { def } from './file-health-reviews.js';
import { mount } from '$lib/server/api/mount.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function request(body: unknown, admin = true): RequestEvent {
    const url = new URL('http://localhost/api/admin/media/file-health/reviews');
    return {
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: {},
        locals: admin ? adminSession() : adminOwnersReadWritePat(),
        route: { id: '/api/admin/media/file-health/reviews' },
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.mockReturnValue({});
    mocks.preview.mockResolvedValue({
        fileId: FILE,
        fileName: 'file.mkv',
        filePath: '/test/file.mkv',
        snapshot: 'a'.repeat(64),
        eligible: false,
        blockedReason: 'needs-recheck',
        findings: [],
        history: [],
    });
});
it('admin preview is read-only; owner read/write credentials are insufficient', async () => {
    const post = mount(def, { surface: 'internal' }).POST!;
    expect((await post(request({ action: 'preview', fileId: FILE }, false))).status).toBe(403);
    expect(mocks.preview).not.toHaveBeenCalled();
    const response = await post(request({ action: 'preview', fileId: FILE }));
    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe('preview');
    expect(mocks.write).not.toHaveBeenCalled();
});
it.each([
    { action: 'preview', fileId: FILE, actor: 'injected' },
    {
        action: 'confirm',
        fileId: FILE,
        snapshot: 'a'.repeat(64),
        issueKeys: ['b'.repeat(64)],
        reason: 'valid reason here',
        evidence: 'long enough inspection evidence',
        contentReviewed: false,
    },
    { action: 'revoke', fileId: 'not-a-uuid', reviewId: FILE },
])('rejects invalid or undeclared review input', async (body) => {
    expect((await mount(def, { surface: 'internal' }).POST!(request(body))).status).toBe(422);
    expect(mocks.write).not.toHaveBeenCalled();
});
it('takes audit identity from the authenticated admin', async () => {
    mocks.write.mockResolvedValue(true);
    const event = request({ action: 'revoke', fileId: FILE, reviewId: FILE });
    expect((await mount(def, { surface: 'internal' }).POST!(event)).status).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ action: 'revoke' }),
        event.locals.principal?.username ?? event.locals.user?.username,
        expect.objectContaining({ userId: event.locals.principal?.userId }),
    );
});

it('accepts bounded multi-byte reason and evidence notes at their documented limits', async () => {
    mocks.write.mockResolvedValue(20);
    const body = {
        action: 'confirm',
        fileId: FILE,
        snapshot: 'a'.repeat(64),
        issueKeys: Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(64, '0')),
        reason: '漢'.repeat(1000),
        evidence: '漢'.repeat(2000),
    };
    expect((await mount(def, { surface: 'internal' }).POST!(request(body))).status).toBe(200);
});

it('accepts the exact preview without notes or an inspection assertion', async () => {
    mocks.write.mockResolvedValue(1);
    const body = {
        action: 'confirm',
        fileId: FILE,
        snapshot: 'a'.repeat(64),
        issueKeys: ['b'.repeat(64)],
    };
    expect((await mount(def, { surface: 'internal' }).POST!(request(body))).status).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith({}, body, expect.any(String), expect.any(Object));
});

it.each([
    ['conflict', 'File changed', 409],
    ['conflict', 'Stream inventory changed', 409],
    ['conflict', 'Assessment changed', 409],
    ['invalid', 'Unsupported technical failure', 422],
] as const)(
    'rejects %s evidence through the mounted endpoint: %s',
    async (kind, message, status) => {
        mocks.write.mockRejectedValue(new FileHealthReviewError(kind, message));
        const body = {
            action: 'confirm',
            fileId: FILE,
            snapshot: 'a'.repeat(64),
            issueKeys: ['b'.repeat(64)],
        };
        expect((await mount(def, { surface: 'internal' }).POST!(request(body))).status).toBe(
            status,
        );
    },
);
