// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/audiobooks/{mediaId}/files/{trackIndex} — direct-play byte proxy.
 *
 * Auth is the stream token, validated in-route (see
 * `services/audiobook-stream-auth.ts`). The body lives in
 * `services/audiobook-stream-routes.ts` because a `+server.ts` may export only
 * reserved names, so nothing else can import a helper from here.
 */

export {
    handleAudiobookFile as GET,
    handleAudiobookFile as HEAD,
} from '$lib/server/services/audiobook-stream-routes.js';
