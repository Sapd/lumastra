// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi } from 'vitest';
import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const { GET } = await import('./+server.js');
const { GET: legacyGet } = await import('../../../Users/[userId]/Items/[itemId]/Intros/+server.js');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';

describe('GET /j/Items/{itemId}/Intros', () => {
    it('is the legacy /Users/{userId}/Items/{itemId}/Intros handler', () => {
        expect(GET).toBe(legacyGet);
    });

    it('answers an empty BaseItemDtoQueryResult', async () => {
        const url = new URL(`https://app.example/j/Items/${ITEM_ID}/Intros`);
        const res = await GET!({
            request: new Request(url),
            url,
            params: { itemId: ITEM_ID },
            locals: { user: { userId: 'uid-alice', username: 'alice' } },
        } as never);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    });
});
