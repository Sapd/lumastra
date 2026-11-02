// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Lumastra has no DVR: the list routes answer Jellyfin's empty QueryResult and the
// item routes 404, for users with and without Live TV permission alike.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

import { GET as recordings } from './Recordings/+server';
import { GET as recordingsSeries } from './Recordings/Series/+server';
import { GET as recordingsGroups } from './Recordings/Groups/+server';
import { GET as recordingsFolders } from './Recordings/Folders/+server';
import { GET as timers } from './Timers/+server';
import { GET as seriesTimers } from './SeriesTimers/+server';
import { GET as recording } from './Recordings/[recordingId]/+server';
import { GET as timer } from './Timers/[timerId]/+server';
import { GET as seriesTimer } from './SeriesTimers/[timerId]/+server';

type Handler = (e: RequestEvent) => Promise<Response>;

function event(hasLiveTvPermission: boolean): RequestEvent {
    return {
        url: new URL('https://x.test/j/LiveTv/x'),
        params: { recordingId: 'abc', timerId: 'abc' },
        locals: { user: { userId: 'u', hasLiveTvPermission } },
    } as unknown as RequestEvent;
}

describe('/j/LiveTv DVR routes without a DVR', () => {
    const lists = {
        recordings,
        recordingsSeries,
        recordingsGroups,
        recordingsFolders,
        timers,
        seriesTimers,
    };
    for (const [name, handler] of Object.entries(lists)) {
        it(`${name} answers an empty QueryResult`, async () => {
            for (const permitted of [true, false]) {
                const res = await (handler as unknown as Handler)(event(permitted));
                expect(res.status).toBe(200);
                expect(await res.json()).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
            }
        });
    }

    for (const [name, handler] of Object.entries({ recording, timer, seriesTimer })) {
        it(`${name}/{id} is 404`, async () => {
            const res = await (handler as unknown as Handler)(event(true));
            expect(res.status).toBe(404);
        });
    }
});
