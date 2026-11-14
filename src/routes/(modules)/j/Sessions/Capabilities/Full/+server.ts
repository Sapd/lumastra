// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { capabilitiesFromDto } from '$lib/server/jellyfin-compat/remote-control/protocol';
import { reportCapabilities } from '$lib/server/jellyfin-compat/remote-control/capabilities';
import {
    badRequest,
    readJsonBody,
} from '$lib/server/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.PostFullCapabilities — a ClientCapabilitiesDto
 * body. Stored like /Sessions/Capabilities; the DeviceProfile is not kept
 * (PlaybackInfo receives the profile with each request).
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const body = await readJsonBody(event.request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return badRequest('Body must be a ClientCapabilitiesDto');
        }
        return reportCapabilities(event, capabilitiesFromDto(body));
    },
    { pat: 'deny', mode: 'write' },
);
