// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Compatibility Layer — Global Suggestions
 *
 * Redirects to per-user suggestions using the authenticated user.
 * Some clients call /Items/Suggestions instead of /Users/{userId}/Suggestions.
 */
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleSuggestions } from '$lib/server/proprietary/jellyfin-compat/suggestions-handler';

export const GET: RequestHandler = withJellyfinAuth(handleSuggestions);
