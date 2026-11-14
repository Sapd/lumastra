// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /PlayingItems/{itemId}/Progress: the userless spelling of
// /Users/{userId}/PlayingItems/{itemId}/Progress. Re-export the canonical handler.
export { POST } from '../../../Users/[userId]/PlayingItems/[itemId]/Progress/+server';
