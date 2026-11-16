// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/me/downloads/slots: own slots only, cross-site guard, started probe.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({ DOWNLOAD_MAX_PARALLEL_PER_USER: 3 }));
const mockList = vi.fn();
const mockSeen = vi.fn();

vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/services/download-handoff.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/services/download-handoff.js')>();
    return { ...actual, handoffSeen: (...a: unknown[]) => mockSeen(...a) };
});
vi.mock('$lib/server/services/download-leases.js', () => ({
    listActiveDownloads: (...a: unknown[]) => mockList(...a),
}));
vi.mock('$lib/paraglide/messages', () => ({ downloads_not_allowed: () => 'no' }));
vi.mock('$lib/server/services/download-access.service.js', () => ({
    canDownload: async () => true,
    userMayDownload: async () => true,
}));
vi.mock('$lib/server/auth/locals-admin.js', () => ({ localsIsAdmin: () => false }));

const { def } = await import('./slots.js');

async function call(
    query = '',
    headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
) {
    const url = `http://localhost/api/me/downloads/slots${query}`;
    const h = new URL(url).searchParams.get('h') ?? undefined;
    const res = await def.handlers.GET!(
        {
            locals: { user: { userId: 'u1' } },
            url: new URL(url),
            request: new Request(url, { headers }),
        } as unknown as RequestEvent,
        { input: { query: h ? { h } : {} } } as never,
    );
    return { res, body: res.status === 200 ? await res.json() : null };
}

beforeEach(() => {
    vi.clearAllMocks();
    cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 3;
    mockList.mockResolvedValue([
        { userId: 'u1', fileId: 'f1', deviceKey: 'd1', bytesSent: 0, startedAt: 0, bytesPerSec: 0 },
        { userId: 'u1', fileId: 'f2', deviceKey: 'd2', bytesSent: 0, startedAt: 0, bytesPerSec: 0 },
        {
            userId: 'other',
            fileId: 'f9',
            deviceKey: 'd',
            bytesSent: 0,
            startedAt: 0,
            bytesPerSec: 0,
        },
    ]);
    mockSeen.mockResolvedValue(false);
});

describe('me/downloads/slots', () => {
    it("reports the limit and only the caller's live slots, across devices", async () => {
        const { body } = await call();
        expect(body).toEqual({ maxParallel: 3, inUse: 2 });
    });

    it('0 = unlimited is passed through', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 0;
        expect((await call()).body.maxParallel).toBe(0);
    });

    it('a cross-site request is refused, and so is a header-less one without a Referer', async () => {
        expect((await call('', { 'sec-fetch-site': 'cross-site' })).res.status).toBe(403);
        expect((await call('', { accept: '*/*' })).res.status).toBe(403);
        expect((await call('', { referer: 'http://localhost/library' })).res.status).toBe(200);
        expect(mockList).toHaveBeenCalledTimes(1);
    });

    it('h: started only when THAT nonce was seen for this user', async () => {
        mockSeen.mockResolvedValue(true);
        const { body } = await call('?h=abcdef123456');
        expect(body.started).toBe(true);
        expect(mockSeen).toHaveBeenCalledWith('u1', 'abcdef123456');
    });

    it('h: an unknown nonce is not started, even while the same file runs on another device', async () => {
        // f1 is running (another device) but this hand-off was never seen
        const { body } = await call('?h=abcdef123456');
        expect(body.started).toBe(false);
    });

    it('a malformed nonce is ignored (no started field, no lookup)', async () => {
        const { body } = await call('?h=%24%24');
        expect(body.started).toBeUndefined();
        expect(mockSeen).not.toHaveBeenCalled();
    });

    it('without h there is no started field', async () => {
        expect((await call()).body).not.toHaveProperty('started');
    });
});
