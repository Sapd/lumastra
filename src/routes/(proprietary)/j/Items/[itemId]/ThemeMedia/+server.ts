// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/ThemeMedia (LibraryController.GetThemeMedia). Lumastra does not
// ingest theme assets, so the result is always empty (see handleThemeMedia).
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleThemeMedia } from '$lib/server/proprietary/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth((event) => handleThemeMedia(event, 'all'));
