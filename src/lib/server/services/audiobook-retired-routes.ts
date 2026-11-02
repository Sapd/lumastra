// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The answer to the singular audiobook byte paths P9 retired
 * (`/api/v1/audiobook/{mediaId}/file/{ino}` and `/remux/{ino}`).
 *
 * `410 route_retired` for every id, so the response reveals nothing about the book.
 * hooks.server.ts lets GET and HEAD through the /api/v1 auth backstop for exactly these
 * paths (isRetiredAudiobookBytePath). HEAD gets the same status and headers with no body.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { problem } from '../api/problem.js';

const RETIRED_MESSAGE =
    'This audiobook byte route was retired. Start a new play session and follow the issued /api/v1/audiobooks/{mediaId}/files/{trackIndex} or /api/v1/audiobooks/{mediaId}/remux/{trackIndex} URL.';

export function retiredAudiobookBytes(event: RequestEvent): Response {
    const response = problem('route_retired', { error: RETIRED_MESSAGE });
    if (event.request.method !== 'HEAD') return response;
    return new Response(null, { status: response.status, headers: response.headers });
}
