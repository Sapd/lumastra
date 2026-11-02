// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Audiobook HLS proxy; child URIs carry ?grant= and the session binding. */

export {
    handleAudiobookHls as GET,
    handleAudiobookHls as HEAD,
} from '$lib/server/services/audiobook-stream-routes.js';
