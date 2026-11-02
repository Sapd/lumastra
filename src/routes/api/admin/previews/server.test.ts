// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/services/preview-admission.service', () => ({
    getPreviewAdmissionStatus: vi.fn(),
    setPreviewsAdminDisabled: vi.fn(),
}));

import {
    getPreviewAdmissionStatus,
    setPreviewsAdminDisabled,
} from '$lib/server/services/preview-admission.service';
import { GET, POST } from './+server';

if (!GET) throw new Error('GET not exported');
if (!POST) throw new Error('POST not exported');

type GetEvent = Parameters<typeof GET>[0];
type PostEvent = Parameters<typeof POST>[0];

const CACHE_STATS = {
    entries: 3,
    ready: 2,
    warming: 1,
    totalBytes: 1024,
    maxBytes: 4096,
    hits: 5,
    misses: 1,
    evictions: 0,
};

const ADMISSION_STATUS = {
    disabled: false,
    reason: null,
    loadRatio: 0.1,
    loadShedRatio: 3,
    activeCount: 0,
    maxGlobal: 8,
    adminDisabled: false,
    autoDisabled: false,
    cache: CACHE_STATS,
};

function mkLocals(isAdmin: boolean | undefined): Record<string, unknown> {
    if (isAdmin === undefined) return {};
    return { user: { username: 'denis', isAdmin }, principal: { isAdmin } };
}

function mkGetEvent(isAdmin: boolean | undefined): GetEvent {
    const url = new URL('http://x/api/admin/previews');
    return {
        params: {},
        url,
        request: new Request(url),
        locals: mkLocals(isAdmin),
    } as unknown as GetEvent;
}

function mkPostEvent(isAdmin: boolean | undefined, body: unknown): PostEvent {
    const url = new URL('http://x/api/admin/previews');
    return {
        params: {},
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        locals: mkLocals(isAdmin),
    } as unknown as PostEvent;
}

describe('GET /api/admin/previews', () => {
    beforeEach(() => vi.clearAllMocks());

    test('403 when caller is not an admin', async () => {
        expect(GET).toBeDefined();
        const res = await GET!(mkGetEvent(false));
        expect(res.status).toBe(403);
        expect(getPreviewAdmissionStatus).not.toHaveBeenCalled();
    });

    test('403 when caller is unauthenticated', async () => {
        expect(GET).toBeDefined();
        const res = await GET!(mkGetEvent(undefined));
        expect(res.status).toBe(403);
    });

    test('returns { admission, cache } for an admin', async () => {
        vi.mocked(getPreviewAdmissionStatus).mockResolvedValue(ADMISSION_STATUS);
        expect(GET).toBeDefined();
        const res = await GET!(mkGetEvent(true));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.admission).toEqual(ADMISSION_STATUS);
        expect(body.cache).toEqual(CACHE_STATS);
    });
});

describe('POST /api/admin/previews', () => {
    beforeEach(() => vi.clearAllMocks());

    test('403 when caller is not an admin', async () => {
        expect(POST).toBeDefined();
        const res = await POST!(mkPostEvent(false, { disabled: true }));
        expect(res.status).toBe(403);
        expect(setPreviewsAdminDisabled).not.toHaveBeenCalled();
    });

    test('toggles disabled=true via setPreviewsAdminDisabled and returns fresh status', async () => {
        vi.mocked(getPreviewAdmissionStatus).mockResolvedValue({
            ...ADMISSION_STATUS,
            disabled: true,
            reason: 'admin_disabled',
            adminDisabled: true,
        });
        expect(POST).toBeDefined();
        const res = await POST!(mkPostEvent(true, { disabled: true }));
        expect(res.status).toBe(200);
        expect(setPreviewsAdminDisabled).toHaveBeenCalledWith(true);
        const body = await res.json();
        expect(body.admission.adminDisabled).toBe(true);
    });

    test('toggles disabled=false via setPreviewsAdminDisabled', async () => {
        vi.mocked(getPreviewAdmissionStatus).mockResolvedValue(ADMISSION_STATUS);
        expect(POST).toBeDefined();
        const res = await POST!(mkPostEvent(true, { disabled: false }));
        expect(res.status).toBe(200);
        expect(setPreviewsAdminDisabled).toHaveBeenCalledWith(false);
    });

    test('422 validation_failed when body is malformed', async () => {
        vi.mocked(getPreviewAdmissionStatus).mockResolvedValue(ADMISSION_STATUS);
        expect(POST).toBeDefined();
        const res = await POST!(mkPostEvent(true, { disabled: 'yes' }));
        expect(res.status).toBe(422);
        expect(setPreviewsAdminDisabled).not.toHaveBeenCalled();
    });
});
