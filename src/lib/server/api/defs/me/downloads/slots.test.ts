// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/me/downloads/slots: own slots only, cross-site guard, started probe.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({ DOWNLOAD_MAX_PARALLEL_PER_USER: 3 }));
const mockList = vi.fn();
const mockRecent = vi.fn();

vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/download-events.queries.js', () => ({
    hasRecentDownloadStart: (...a: unknown[]) => mockRecent(...a),
}));
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

async function call(query = '', headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) {
    const url = `http://localhost/api/me/downloads/slots${query}`;
    const fileId = new URL(url).searchParams.get('fileId') ?? undefined;
    const res = await def.handlers.GET!(
        {
            locals: { user: { userId: 'u1' } },
            url: new URL(url),
            request: new Request(url, { headers }),
        } as unknown as RequestEvent,
        { input: { query: fileId ? { fileId } : {} } } as never,
    );
    return { res, body: res.status === 200 ? await res.json() : null };
}

beforeEach(() => {
    vi.clearAllMocks();
    cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 3;
    mockList.mockResolvedValue([
        { userId: 'u1', fileId: 'f1', deviceKey: 'd1', bytesSent: 0, startedAt: 0, bytesPerSec: 0 },
        { userId: 'u1', fileId: 'f2', deviceKey: 'd2', bytesSent: 0, startedAt: 0, bytesPerSec: 0 },
        { userId: 'other', fileId: 'f9', deviceKey: 'd', bytesSent: 0, startedAt: 0, bytesPerSec: 0 },
    ]);
    mockRecent.mockResolvedValue(false);
});

describe('me/downloads/slots', () => {
    it('reports the limit and only the caller\'s live slots, across devices', async () => {
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

    it('fileId: started is true for a running slot without asking the log', async () => {
        const { body } = await call('?fileId=f1');
        expect(body.started).toBe(true);
        expect(mockRecent).not.toHaveBeenCalled();
    });

    it('fileId: a finished short download shows as started through the log', async () => {
        mockRecent.mockResolvedValue(true);
        const { body } = await call('?fileId=f3');
        expect(body.started).toBe(true);
        expect(mockRecent).toHaveBeenCalledWith(expect.anything(), 'u1', 'f3', expect.any(Date));
    });

    it('fileId: nothing running and nothing logged is not started', async () => {
        expect((await call('?fileId=f3')).body.started).toBe(false);
    });
});
