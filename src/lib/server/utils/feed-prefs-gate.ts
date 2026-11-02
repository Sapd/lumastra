// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-side helper for enforcing per-user For You feed preferences at section
 * endpoints — the authoritative backstop for clients that don't skip hidden
 * sections themselves (tvOS / Bearer hitting the v1 surface, direct API calls).
 *
 * The web app already skips hidden sections client-side, so a visible-section
 * request pays at most one extra single-row PK read; a hidden-section request on
 * the web never reaches the endpoint at all.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { loadFeedPrefsForUser } from '$lib/server/database/queries/user-preferences.queries.js';
import { isSectionVisible } from '$lib/shared/feed-section-kinds';

/**
 * True when the given feed section KIND is hidden for the request's user.
 * Anonymous / no-user requests are never gated (returns false → show), matching
 * the "default to full / show everything" contract used everywhere else.
 */
export async function isFeedKindHidden(
    locals: RequestEvent['locals'],
    kind: string,
): Promise<boolean> {
    const userId = locals.user?.userId;
    if (!userId) return false;
    const prefs = await loadFeedPrefsForUser(getDb(), userId);
    return !isSectionVisible(kind, prefs);
}
