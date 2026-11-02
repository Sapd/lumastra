// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET and HEAD /api/v1/audiobook/{mediaId}/remux/{ino}: retired by the P9 audiobook byte
 * cutover. Answers 410 route_retired; see services/audiobook-retired-routes.ts.
 */

export {
    retiredAudiobookBytes as GET,
    retiredAudiobookBytes as HEAD,
} from '$lib/server/services/audiobook-retired-routes.js';
