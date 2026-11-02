// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Users/{userId}/Items/{itemId}/SpecialFeatures — the legacy path (Jellyfin < 10.9
// clients); answers for the authenticated user like /Items/{itemId}/SpecialFeatures.
export { GET } from '../../../../../Items/[itemId]/SpecialFeatures/+server';
