// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/audiobooks/{mediaId}/remux/{trackIndex}?session=…&t=… — on-the-fly AAC.
 *
 * For the files AudiobookShelf direct-plays but a browser cannot decode (E-AC-3
 * inside `.m4b`: ABS negotiates on the container MIME type, Chromium throws
 * `EncodingError`). One ffmpeg per request, piped; a seek is a new request with a
 * new `?t=`, because a piped encode cannot answer `Range`.
 *
 * Auth is the stream token plus the ABS session pin, validated in-route (see
 * `services/audiobook-stream-auth.ts`). The body lives in
 * `services/audiobook-stream-routes.ts` because a `+server.ts` may export only
 * reserved names, so nothing else can import a helper from here.
 */

export {
    handleAudiobookRemux as GET,
    handleAudiobookRemux as HEAD,
} from '$lib/server/services/audiobook-stream-routes.js';
