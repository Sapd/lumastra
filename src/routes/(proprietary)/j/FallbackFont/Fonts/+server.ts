// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /FallbackFont/Fonts (Jellyfin SubtitleController) — the fonts an admin
 * configured for rendering ASS/SSA subtitles client-side when the subtitle
 * names a font it does not embed. Lumastra has no fallback-font setting (it
 * serves fonts embedded in the file as attachments instead), so the list is
 * empty and /FallbackFont/Fonts/{name} is a 404.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import type { JellyfinFontFile } from '$lib/server/proprietary/jellyfin-compat/types';

export const GET: RequestHandler = withJellyfinAuth(() => json([] satisfies JellyfinFontFile[]));
