// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { getHomeActiveSessions } from '$lib/server/services/home-active-sessions.service.js';

// Internal UI projection: the home widget has viewer visibility semantics,
// distinct from the mine/admin-only playback-management resource.
export const { GET } = mount(
    defineEndpoint({
        auth: { kind: 'user' },
        handlers: {
            GET: async (event) =>
                json(await getHomeActiveSessions(event.locals), {
                    headers: { 'Cache-Control': 'private, no-store' },
                }),
        },
    }),
    { surface: 'internal' },
);
