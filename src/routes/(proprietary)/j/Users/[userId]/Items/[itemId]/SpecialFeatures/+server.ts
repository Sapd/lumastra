// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Users/{userId}/Items/{itemId}/SpecialFeatures — the legacy path (Jellyfin < 10.9
// clients); answers for the authenticated user like /Items/{itemId}/SpecialFeatures.
export { GET } from '../../../../../Items/[itemId]/SpecialFeatures/+server';
