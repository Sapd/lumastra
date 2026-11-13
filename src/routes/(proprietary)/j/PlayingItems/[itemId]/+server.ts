// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /PlayingItems/{itemId} (playback started) and DELETE /PlayingItems/{itemId}
// (stopped): Jellyfin 10.9+'s userless spelling of the legacy
// /Users/{userId}/PlayingItems/{itemId} routes (Streamyfin uses it). Both refer to
// the authenticated user — re-export the canonical handlers.
export { POST, DELETE } from '../../Users/[userId]/PlayingItems/[itemId]/+server';
