// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

import { POST } from './+server';

describe('POST /j/LiveStreams/Close', () => {
    it('is a no-op 204', async () => {
        const event = {
            url: new URL('https://x.test/j/LiveStreams/Close?liveStreamId=abc'),
            locals: { user: { userId: 'u' } },
        } as unknown as RequestEvent;
        const res = await (POST as unknown as (e: RequestEvent) => Promise<Response>)(event);
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
    });
});
