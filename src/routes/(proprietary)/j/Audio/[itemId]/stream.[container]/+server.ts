// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Audio/{itemId}/stream.{container} — the file itself (static=true or a
 * clean match for the container) or a progressive encode to mp3/aac/m4a/opus.
 *
 * Auth per branch: `Static=true` takes a play token like /Audio/{itemId}/stream
 * and otherwise a session; the direct/transcode branch is session only
 * (withJellyfinAuth, PATs refused). The logic lives in
 * jellyfin-compat/audio-stream-container.ts and audio-stream.ts.
 */

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serveAudioPlayToken,
    serveAuthenticatedAudioStream,
} from '$lib/server/proprietary/jellyfin-compat/audio-stream';
import {
    isStaticAudioRequest,
    normalizeContainer,
    serveAudioStreamByContainer,
} from '$lib/server/proprietary/jellyfin-compat/audio-stream-container';

const authenticatedStatic = withJellyfinAuth(serveAuthenticatedAudioStream, { pat: 'deny' });

const authenticatedByContainer = withJellyfinAuth(
    (event) => {
        const container = normalizeContainer(event.params.container);
        if (!container) return ApiResponses.badRequest('Invalid container');
        return serveAudioStreamByContainer(event, container);
    },
    { pat: 'deny' },
);

export const GET: RequestHandler = withErrorHandler(async (event) => {
    if (!normalizeContainer(event.params.container)) {
        return ApiResponses.badRequest('Invalid container');
    }
    if (isStaticAudioRequest(event.url)) {
        return (await serveAudioPlayToken(event)) ?? authenticatedStatic(event);
    }
    return authenticatedByContainer(event);
});
