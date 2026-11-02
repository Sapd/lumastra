// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: user — reached through the normal forward-auth gate, no bypass. A
// public error sink is a log-flood vector, and a client crash that happens
// while signed in is the case worth capturing; see the header for the
// deliberate blind spot this leaves.

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database/connection.js';
import { recordJsErrorFromLegacy } from '$lib/server/services/client-diagnostics/ingest.service.js';

const logger = Logger.for('client-errors');

/**
 * POST /api/client-errors — the server end of the errorId shown to the user.
 *
 * WHY THIS EXISTS
 *
 * `hooks.client.ts handleError` mints a correlation id for every uncaught
 * client error and both error pages render it as a REFERENCE the user is asked
 * to quote. Until now that id went to `console.error` and nowhere else, so the
 * id a reporter quoted matched NOTHING an operator could search: the visible
 * half of the correlation existed without the half that makes it worth
 * quoting. The only other sink, `/api/dev/client-errors`, answers 404 outside
 * dev by design.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT
 *
 * Enough to act on a report and no more. `url` is reduced to its PATHNAME by
 * the caller and again here — a query string on this app routinely carries
 * search terms, which are user content. `message` and `stack` are truncated;
 * they are the only fields that can carry arbitrary text, and they are also
 * the only fields that make a report diagnosable, so they are kept rather than
 * dropped. Nothing else from the page is read: no cookies, no body, no
 * referrer.
 *
 * The report is also stored as a `js_error` diagnostic in `client_diagnostics` (best
 * effort — see below), so the reference the user quotes is searchable in Admin →
 * Client diagnostics.
 *
 * ALWAYS 204
 *
 * The caller is `navigator.sendBeacon`, which cannot read a response and must
 * not be given a reason to retry. A rejected payload, a rate-limited caller and
 * a successful record are indistinguishable from the browser — deliberately, so
 * this endpoint can never become an oracle for whether a user id or route
 * exists.
 *
 * BLIND SPOT, stated rather than discovered later: an error thrown before the
 * user is authenticated (the login entrance itself) is not captured, because
 * this route sits behind the same gate as everything else. Making it public to
 * catch that case would hand anonymous callers a write path into the operator's
 * logs. The trade is deliberate.
 */

/** Caps. Generous enough to diagnose, small enough that the log cannot be flooded by one report. */
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_ROUTE = 200;
const MAX_BODY_BYTES = 16_000;

/** Per-user budget. A wedged render loop reports once a second at worst; this absorbs a burst and then stops. */
const RATE_LIMIT = 20;
const RATE_WINDOW_SECONDS = 300;

/** Coerce to a trimmed string of at most `max` chars, or undefined when there is nothing usable. */
function str(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.length > max ? trimmed.slice(0, max) + '…[truncated]' : trimmed;
}

/**
 * Keep only the path. A caller that sends a full URL — or one that forgets to
 * strip the query — must not be able to put search terms into the log, so this
 * re-does the reduction the client already performs instead of trusting it.
 */
function pathOnly(value: unknown): string | undefined {
    const raw = str(value, 2000);
    if (!raw) return undefined;
    try {
        return str(new URL(raw, 'http://placeholder.invalid').pathname, MAX_ROUTE);
    } catch {
        return str(raw.split('?')[0]?.split('#')[0], MAX_ROUTE);
    }
}

export const POST: RequestHandler = withErrorHandler(async ({ request, locals }) => {
    const userId = locals.user?.userId ?? locals.user?.username ?? 'unknown';

    const rate = await checkRateLimit(`client-errors:${userId}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
    if (!rate.allowed) {
        return new Response(null, { status: 204 });
    }

    // sendBeacon sets its own content type from the Blob, so do not gate on it.
    // Read as text and parse by hand: a malformed body is a no-op, not a 400 the
    // caller could never see anyway.
    let body: Record<string, unknown>;
    try {
        const parsed: unknown = await readBoundedJson(request, MAX_BODY_BYTES);
        if (typeof parsed !== 'object' || parsed === null)
            return new Response(null, { status: 204 });
        body = parsed as Record<string, unknown>;
    } catch {
        return new Response(null, { status: 204 });
    }

    const errorId = str(body.errorId, 100);
    if (!errorId) return new Response(null, { status: 204 });

    logger.error('Client error reported', {
        errorId,
        userId,
        routeId: str(body.routeId, MAX_ROUTE) ?? null,
        path: pathOnly(body.url) ?? null,
        status: typeof body.status === 'number' ? body.status : null,
        name: str(body.name, 100) ?? null,
        message: str(body.message, MAX_MESSAGE) ?? null,
        stack: str(body.stack, MAX_STACK) ?? null,
    });

    // Also land it in client_diagnostics so the reference the user quotes is searchable
    // in Admin → Client diagnostics. Best effort: the beacon caller cannot see errors.
    const dbUserId = locals.user?.userId;
    const sql = getDb();
    if (dbUserId && sql) {
        try {
            await recordJsErrorFromLegacy(sql, dbUserId, {
                errorId,
                name: str(body.name, 100),
                message: str(body.message, MAX_MESSAGE),
                stack: str(body.stack, MAX_STACK),
                path: pathOnly(body.url),
                // Hard cut, not str()'s "…[truncated]" suffix: the envelope caps
                // appVersion at 32 chars and an over-long value drops the whole row.
                appVersion: str(body.version, 64)?.slice(0, 32),
            });
        } catch (err) {
            logger.warn('Could not record client error as diagnostic', {
                errorId,
                err: String(err),
            });
        }
    }

    return new Response(null, { status: 204 });
});
