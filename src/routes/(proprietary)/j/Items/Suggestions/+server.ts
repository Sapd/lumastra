// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

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
