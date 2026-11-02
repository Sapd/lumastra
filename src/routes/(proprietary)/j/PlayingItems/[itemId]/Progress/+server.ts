// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// POST /PlayingItems/{itemId}/Progress: the userless spelling of
// /Users/{userId}/PlayingItems/{itemId}/Progress. Re-export the canonical handler.
export { POST } from '../../../Users/[userId]/PlayingItems/[itemId]/Progress/+server';
