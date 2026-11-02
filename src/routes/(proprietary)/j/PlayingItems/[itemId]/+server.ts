// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// POST /PlayingItems/{itemId} (playback started) and DELETE /PlayingItems/{itemId}
// (stopped): Jellyfin 10.9+'s userless spelling of the legacy
// /Users/{userId}/PlayingItems/{itemId} routes (Streamyfin uses it). Both refer to
// the authenticated user — re-export the canonical handlers.
export { POST, DELETE } from '../../Users/[userId]/PlayingItems/[itemId]/+server';
