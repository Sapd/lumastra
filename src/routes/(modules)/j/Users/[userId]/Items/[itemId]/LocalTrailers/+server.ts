// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Users/{userId}/Items/{itemId}/LocalTrailers — the legacy path (Jellyfin < 10.9
// clients); answers for the authenticated user like /Items/{itemId}/LocalTrailers.
export { GET } from '../../../../../Items/[itemId]/LocalTrailers/+server';
