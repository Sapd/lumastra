// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Legacy Emby/Jellyfin clients (incl. jellyfin-androidtv) call the userless
// /UserFavoriteItems/{itemId} path; modern clients call /Users/{userId}/FavoriteItems/{itemId}.
// Both refer to the authenticated user. Re-export the canonical handler.
export { POST, DELETE } from '../../Users/[userId]/FavoriteItems/[itemId]/+server';
