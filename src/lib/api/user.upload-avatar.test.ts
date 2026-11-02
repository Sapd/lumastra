// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadAvatar } from './user';

afterEach(() => vi.unstubAllGlobals());

function file(): File {
    return new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' });
}

describe('uploadAvatar', () => {
    it('reports the status and server message of a JSON 413', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json({ error: 'File too large (max 2 MB)' }, { status: 413 }),
            ),
        );

        await expect(uploadAvatar('alice', file())).resolves.toEqual({
            success: false,
            status: 413,
            error: 'File too large (max 2 MB)',
        });
    });

    it("reports the status of a reverse proxy's HTML 413", async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response('<html>413 Request Entity Too Large</html>', {
                        status: 413,
                        statusText: 'Request Entity Too Large',
                        headers: { 'content-type': 'text/html' },
                    }),
            ),
        );

        const result = await uploadAvatar('alice', file());

        expect(result.success).toBe(false);
        expect(result.status).toBe(413);
    });
});
