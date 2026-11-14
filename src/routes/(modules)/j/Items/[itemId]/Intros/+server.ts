// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/Intros — the userless path Jellyfin 10.9+ clients call
// (UserLibraryController.GetIntros); the legacy one is /Users/{userId}/Items/{itemId}/Intros.
// Both answer for the authenticated user. Lumastra has no cinema-mode intro
// providers, so the result is always empty, as on a Jellyfin server without one.
export { GET } from '../../../Users/[userId]/Items/[itemId]/Intros/+server';
