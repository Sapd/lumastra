// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// jellyfin-androidtv uploads its log every ~70 minutes and retries ~15 times
// when the upload fails. With no route here that was 510 × 404 in a single day
// from one television — the loudest thing in the /j access log by an order of
// magnitude, and every one of them noise.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDebug, mockInfo, mockWarn, mockStore } = vi.hoisted(() => ({
    mockDebug: vi.fn(),
    mockInfo: vi.fn(),
    mockWarn: vi.fn(),
    mockStore: vi.fn(),
}));

vi.mock('$lib/server/database', () => ({ getDb: () => ({ fake: 'sql' }) }));
vi.mock('$lib/server/proprietary/jellyfin-compat/client-log-bundle', () => ({
    storeJellyfinClientLog: mockStore,
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: mockInfo, warn: mockWarn, error: vi.fn(), debug: mockDebug }),
    },
}));

import { POST } from './+server';
import { MAX_LOG_BYTES } from './client-log';

function makeEvent(body: string): RequestEvent {
    return {
        url: new URL('https://example.test/j/ClientLog/Document'),
        request: new Request('https://example.test/j/ClientLog/Document', {
            method: 'POST',
            body,
        }),
        locals: {
            user: { userId: '00000000-0000-0000-0000-000000000001', username: 'michael' },
            jfDevice: {
                deviceId: 'device-1',
                deviceName: '4K Hybrid STB',
                clientName: 'Jellyfin Android TV',
                clientVersion: '0.19.10',
            },
        },
    } as unknown as RequestEvent;
}

async function post(body: string): Promise<Response> {
    return (POST as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent(body));
}

describe('POST /j/ClientLog/Document', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStore.mockResolvedValue({ stored: true });
    });

    it('accepts an upload and answers with a Jellyfin-shaped FileName', async () => {
        const response = await post('12:51:27 ERROR could not load item\n');

        expect(response.status).toBe(200);
        const body = (await response.json()) as { FileName: string };
        expect(typeof body.FileName).toBe('string');
        expect(body.FileName.length).toBeGreaterThan(0);
    });

    it('records the log where an operator will actually find it', async () => {
        await post('12:51:27 ERROR could not load item\n');

        expect(mockInfo).toHaveBeenCalledWith(
            expect.stringContaining('Client log'),
            expect.objectContaining({
                clientName: 'Jellyfin Android TV',
                deviceName: '4K Hybrid STB',
                username: 'michael',
            }),
        );
    });

    // The upload is unauthenticated-adjacent input of arbitrary size. Truncate,
    // don't reject: a rejected upload is retried 15 times, which is the exact
    // noise this route exists to stop.
    it('truncates an oversized log instead of refusing it', async () => {
        const response = await post('x'.repeat(MAX_LOG_BYTES + 5_000));

        expect(response.status).toBe(200);
        const [, context] = mockInfo.mock.calls[0] as [string, { bytes: number }];
        expect(context.bytes).toBe(MAX_LOG_BYTES);
    });

    it('counts the ceiling in BYTES, not UTF-16 code units', async () => {
        // '。' is 3 bytes and 1 code unit. Against `String.length` a CJK log
        // sailed past the "256 KB" ceiling at roughly three times the size,
        // and reported a byte count that was wrong the same way.
        const chars = MAX_LOG_BYTES; // = 3 × MAX_LOG_BYTES bytes on the wire
        const response = await post('。'.repeat(chars));

        expect(response.status).toBe(200);
        const [, context] = mockInfo.mock.calls[0] as [string, { bytes: number }];
        expect(context.bytes).toBeLessThanOrEqual(MAX_LOG_BYTES);
    });

    it('reports a body inside the ceiling as not truncated', async () => {
        await post('z'.repeat(1_000));

        const [, context] = mockInfo.mock.calls[0] as [
            string,
            { bytes: number; truncated: boolean },
        ];
        expect(context.truncated).toBe(false);
        expect(context.bytes).toBe(1_000);
    });

    it('does not log the whole document', async () => {
        await post('y'.repeat(10_000));

        const [, context] = mockInfo.mock.calls[0] as [string, { excerpt: string }];
        expect(context.excerpt.length).toBeLessThan(1_000);
    });

    it('accepts an empty upload without failing', async () => {
        const response = await post('');

        expect(response.status).toBe(200);
    });

    it('stores the upload as a log bundle for the session user and device', async () => {
        await post('12:51:27 ERROR could not load item\n');

        expect(mockStore).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                userId: '00000000-0000-0000-0000-000000000001',
                deviceId: 'device-1',
                deviceName: '4K Hybrid STB',
                clientName: 'Jellyfin Android TV',
                clientVersion: '0.19.10',
                text: '12:51:27 ERROR could not load item\n',
                truncated: false,
            }),
        );
    });

    it('still answers 200 { FileName } when the bundle is not stored', async () => {
        mockStore.mockResolvedValueOnce({ stored: false, reason: 'budget' });
        const response = await post('log');

        expect(response.status).toBe(200);
        expect(((await response.json()) as { FileName: string }).FileName.length).toBeGreaterThan(
            0,
        );
    });
});
