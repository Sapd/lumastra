// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV → Server-Driven UI transforms (server re-export)
 *
 * The actual implementation lives in $lib/shared/livetv-transforms.ts
 * so it can be used by both server and client code.
 */
export {
    liveTvChannelToUniversalItem,
    liveTvChannelToWhatsOnItem,
    formatWhatsOnSubtitle,
    getRemainingMinutes,
    filterChannels,
} from '$lib/shared/livetv-transforms.js';
