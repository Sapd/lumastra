// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isRedirect } from '@sveltejs/kit';
import { load } from './+page.server.js';

async function redirectTarget(query: string): Promise<{ status: number; url: URL }> {
    const url = new URL(`http://localhost/admin/users/playback-incidents${query}`);
    // `redirect()` throws synchronously inside the (sync) load.
    let err: unknown;
    try {
        await load({ url } as never);
    } catch (e) {
        err = e;
    }
    if (!isRedirect(err)) throw new Error('expected a redirect');
    return { status: err.status, url: new URL(err.location, 'http://localhost') };
}

describe('legacy /admin/users/playback-incidents redirect', () => {
    it('forwards the filters the new page understands and forces kind=playback_incident', async () => {
        const { status, url } = await redirectTarget(
            '?userId=u-1&deviceId=d-1&q=abc&platform=ios&kind=crash',
        );
        expect(status).toBe(308);
        expect(url.pathname).toBe('/admin/users/client-diagnostics');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            userId: 'u-1',
            deviceId: 'd-1',
            q: 'abc',
            platform: 'ios',
            kind: 'playback_incident',
        });
    });

    it('drops legacy-only params (mediaId, from, to, triggerType, paging)', async () => {
        const { url } = await redirectTarget(
            '?userId=u-1&mediaId=m-1&from=2026-01-01&to=2026-02-01&triggerType=error&offset=50',
        );
        expect(Object.fromEntries(url.searchParams)).toEqual({
            userId: 'u-1',
            kind: 'playback_incident',
        });
    });
});
