// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

export const GET: RequestHandler = withJellyfinAuth(
    async () => {
        // A WebSocket upgrade to /j/socket never reaches this route: the
        // upgrade dispatcher hands it to remote-control/socket-hub.ts. This
        // only answers a plain GET (or an upgrade on a Node without
        // http.Server.shouldUpgradeCallback) with 200, so a client probing the
        // socket URL does not treat the server as unreachable.
        return new Response(null, { status: 200 });
    },
    { pat: 'deny' },
);
