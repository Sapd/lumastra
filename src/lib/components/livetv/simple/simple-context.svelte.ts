// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether Live TV simple mode is on for the watch page, and how to zap to the next channel.
 *
 * SimpleZapOverlay owns the simple-mode lineup and registers itself here; the player's
 * failure card (a sibling subtree) reads it to use the plain wording and to offer
 * "Next channel" from the viewer's own list instead of the full lineup.
 */
class LiveTvSimpleContext {
    active = $state(false);
    zapNext: (() => void) | null = null;
}

export const liveTvSimpleContext = new LiveTvSimpleContext();
