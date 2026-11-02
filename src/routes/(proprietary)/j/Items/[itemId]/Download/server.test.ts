// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /j/Items/{itemId}/Download. Streamyfin downloads
// `/Items/{MediaSources[0].Id}/Download`, and PlaybackInfo's MediaSource.Id is
// a per-file play token, not the item UUID — the route must resolve it.

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockValidatePlayToken, mockCheckMediaAccess, mockHandleDownloadFile } = vi.hoisted(() => ({
    mockValidatePlayToken: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockHandleDownloadFile: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    isStreamLimitBanned: async () => false,
    validatePlayToken: mockValidatePlayToken,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mockCheckMediaAccess,
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn().mockResolvedValue(null),
}));
vi.mock('$lib/server/handlers/media-download-handler', () => ({
    handleDownloadFile: mockHandleDownloadFile,
}));

const { GET } = await import('./+server');

const ITEM_ID = '46b44b87-d6d8-406d-8678-117c96d0af2b';
const FILE_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = '4f57c2d2-8c6a-4305-83dc-365e0cc00101';

function makeEvent(itemId: string, username = 'leon') {
    const url = new URL(`http://localhost/j/Items/${itemId}/Download?ApiKey=k`);
    return {
        params: { itemId },
        url,
        request: new Request(url),
        locals: { user: { username, ownerIsAdmin: false } },
    } as never;
}

describe('GET /j/Items/{itemId}/Download', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockHandleDownloadFile.mockResolvedValue(new Response('ok', { status: 200 }));
    });

    it('resolves a MediaSource.Id file token to the real item and file', async () => {
        mockValidatePlayToken.mockResolvedValue({
            itemId: ITEM_ID,
            fileId: FILE_ID,
            userId: 'leon',
        });

        const res = await GET(makeEvent(TOKEN));

        expect(res.status).toBe(200);
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(expect.anything(), ITEM_ID, {
            username: 'leon',
            ownerIsAdmin: false,
        });
        const event = mockHandleDownloadFile.mock.calls[0][0];
        expect(event.params.itemId).toBe(ITEM_ID);
        expect(event.url.searchParams.get('mediaSourceId')).toBe(FILE_ID);
    });

    it("does not honour another user's file token", async () => {
        mockValidatePlayToken.mockResolvedValue({
            itemId: ITEM_ID,
            fileId: FILE_ID,
            userId: 'someone-else',
        });
        mockCheckMediaAccess.mockResolvedValue(false);

        const res = await GET(makeEvent(TOKEN));

        expect(res.status).toBe(404);
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(
            expect.anything(),
            TOKEN,
            expect.anything(),
        );
        expect(mockHandleDownloadFile).not.toHaveBeenCalled();
    });

    it('passes a plain item id through unchanged', async () => {
        mockValidatePlayToken.mockResolvedValue(null);

        const res = await GET(makeEvent(ITEM_ID));

        expect(res.status).toBe(200);
        const event = mockHandleDownloadFile.mock.calls[0][0];
        expect(event.params.itemId).toBe(ITEM_ID);
        expect(event.url.searchParams.get('mediaSourceId')).toBeNull();
    });
});
