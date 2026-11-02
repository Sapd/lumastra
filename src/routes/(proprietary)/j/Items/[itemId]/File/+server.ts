// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin Compat: GET /Items/{itemId}/File — the item's original file, with
 * byte ranges (Jellyfin LibraryController.GetFile).
 *
 * Finamp plays and downloads through this route (`?ApiKey=<token>`), so it is
 * the session path of /Audio/{itemId}/stream: library/age access re-check,
 * kick cooldown, silent-start disarm, then the static file. No play-token
 * branch — Jellyfin requires a signed-in user here and the clients send one.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveAuthenticatedAudioStream } from '$lib/server/proprietary/jellyfin-compat/audio-stream';

export const GET: RequestHandler = withJellyfinAuth(serveAuthenticatedAudioStream, { pat: 'deny' });
