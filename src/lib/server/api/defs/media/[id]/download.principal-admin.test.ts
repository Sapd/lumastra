// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET media/{id}/download, DB-unavailable fallback: only an admin PRINCIPAL may
 * skip the access check; an admin owner's device token gets 503
 * (spec 2026-10-07-auth-route-policy-design §5.1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    adminOwnersDeviceToken,
    adminSession,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

const mockHandleDownloadFile = vi.fn();

vi.mock('$lib/server/handlers/media-download-handler.js', () => ({
    handleDownloadFile: (...a: unknown[]) => mockHandleDownloadFile(...a),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));

const { def } = await import('./download.js');

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { surface: 'v1' } as never;

async function call(locals: RequestEvent['locals']): Promise<Response> {
    const url = `http://localhost/api/v1/media/${ID}/download`;
    return def.handlers.GET!(
        {
            locals,
            url: new URL(url),
            params: { id: ID },
            request: new Request(url),
        } as unknown as RequestEvent,
        ctx,
    );
}

describe('media/{id}/download with the database unavailable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockHandleDownloadFile.mockResolvedValue(new Response('file', { status: 200 }));
    });

    it("an admin owner's device token gets 503", async () => {
        expect((await call(adminOwnersDeviceToken())).status).toBe(503);
        expect(mockHandleDownloadFile).not.toHaveBeenCalled();
    });

    it('a request without a principal gets 503', async () => {
        expect((await call(adminUserWithoutPrincipal())).status).toBe(503);
        expect(mockHandleDownloadFile).not.toHaveBeenCalled();
    });

    it('control: an admin session proceeds to the download handler', async () => {
        expect((await call(adminSession())).status).toBe(200);
        expect(mockHandleDownloadFile).toHaveBeenCalledTimes(1);
    });
});
