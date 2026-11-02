// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `PlaySessionId` resolution for the HLS playback route (C1, security review 3,
 * 2026-09-15/16).
 *
 * Lives beside `+server.ts` rather than inside it because SvelteKit permits only
 * handler exports (GET, POST, …, or a `_` prefix) from a route module, and a
 * stray one fails the build with "Invalid export". Same reason `codec-override.ts`
 * and `file-selection.ts` sit next door.
 *
 * This route is the ONE of the three `startHlsPlayback` callers that already had
 * its own `SAFE_PLAY_SESSION_ID_RE` check before the C1 fix — but instead of
 * rejecting a malformed id, it silently substitutes a fresh `randomUUID()`, so
 * retries and preview sessions attach to the same job on a valid id but a
 * malformed one just gets a new server-generated session rather than a 400. This
 * is intentionally UNCHANGED by the C1 fix: `startHlsPlayback`'s own seam guard
 * is a backstop this caller never reaches (the substituted id always matches the
 * charset), and changing 200-with-a-fresh-session to 400 here would be a
 * behavior change beyond what the finding asked for. Fix-round-1 review
 * (2026-09-16) asked that this behavior be pinned by a test rather than merely
 * asserted in prose — see session-id-resolution.test.ts.
 */

import { SAFE_PLAY_SESSION_ID_RE } from '$lib/server/utils/hls-request-utils.js';

/**
 * Resolve the `PlaySessionId` query param to the value passed to
 * `startHlsPlayback`: the client's own id when it matches the charset
 * whitelist, or a freshly generated one otherwise (including when absent).
 *
 * @param rawSessionId - `url.searchParams.get('PlaySessionId')`
 * @param generateId - id generator, injected for testability (real caller
 *   passes `randomUUID`)
 */
export function resolvePlaySessionId(
    rawSessionId: string | null,
    generateId: () => string,
): string {
    return rawSessionId && SAFE_PLAY_SESSION_ID_RE.test(rawSessionId) ? rawSessionId : generateId();
}
