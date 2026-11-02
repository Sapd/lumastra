// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin Compat: Audio Stream
 *
 * GET /Audio/{itemId}/stream
 *
 * Serves audio files with byte-range support. A play token in the URL
 * (MediaSource.Id, the item id itself, or play_token) is honoured first —
 * media elements cannot send auth headers; otherwise the request needs a
 * session (withJellyfinAuth, PATs refused). The logic lives in
 * jellyfin-compat/audio-stream.ts.
 */

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    serveAudioPlayToken,
    serveAuthenticatedAudioStream,
} from '$lib/server/proprietary/jellyfin-compat/audio-stream';

const authenticatedHandler = withJellyfinAuth(serveAuthenticatedAudioStream, { pat: 'deny' });

export const GET: RequestHandler = withErrorHandler(
    async (event) => (await serveAudioPlayToken(event)) ?? authenticatedHandler(event),
);
