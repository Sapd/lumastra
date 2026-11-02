// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/audiobookshelf — admin-only: connect AudiobookShelf from the
 * first-run wizard's library step.
 *
 * Flow: probe the entered URL + API key against the live server FIRST (so a
 * connection that does not work is never stored), then store it through the
 * same write path as Settings → AudiobookShelf (`settings-write.ts`: env-owned
 * keys refused, audit entry with key names only). The wizard then lists the
 * server's libraries through GET /api/admin/library/remote-libraries and adds
 * the picked ones through POST /api/setup/library, which validates each id
 * against that same saved connection.
 *
 * The URL is operator-typed and the request goes out from the server, so:
 * http(s) only, no credentials/fragment in it, redirects only on the same
 * host (fetchWithTimeout), and failures come back as fixed codes. Nothing from
 * the upstream response other than the library list is ever echoed, and the
 * API key is never logged or returned.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import { probeAudiobookshelf } from '$lib/server/services/remote-library-sources.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { planSettingsUpdates, commitSettingsUpdates } from '$lib/server/admin/settings-write.js';
import {
    checkAudiobookshelfUserMatches,
    type AudiobookshelfUserMatches,
} from '$lib/server/services/audiobookshelf-user-matches.js';

const ENDPOINT = '/api/setup/audiobookshelf';
const MAX_URL_LENGTH = 2048;
const MAX_KEY_LENGTH = 4096;

/**
 * The base URL every ABS request is built on, or null when it is not one.
 * Keeps the proxy subpath and query, and drops trailing path slashes.
 */
function normalizeBaseUrl(raw: string): string | null {
    if (raw.length > MAX_URL_LENGTH) return null;
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password || parsed.hash) return null;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request, locals }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        const url = normalizeBaseUrl(toStringOr(body.url, '').trim());
        const apiKey = toStringOr(body.apiKey, '').trim();
        if (!url) {
            return ApiResponses.badRequest(
                'URL must be an http:// or https:// address',
                undefined,
                ENDPOINT,
            );
        }
        // Whitespace or control characters inside a key are a paste accident,
        // and would only fail later as an invalid header.
        if (!apiKey || apiKey.length > MAX_KEY_LENGTH || /[\s\p{Cc}]/u.test(apiKey)) {
            return ApiResponses.badRequest('A valid API key is required', undefined, ENDPOINT);
        }

        // Planned BEFORE the probe: when the environment owns one of these keys
        // the save is certain to be refused, and the typed key must not be sent
        // anywhere for nothing. FEATURE_AUDIOBOOKS is on by default; connecting
        // a server here means the operator wants it, so a stored `false` would
        // only hide what they just set up. Unchanged values are not written.
        const { updates, envLocked } = planSettingsUpdates({
            AUDIOURL: url,
            AUDIOAPIKEY: apiKey,
            FEATURE_AUDIOBOOKS: true,
        });
        if (envLocked.length > 0) {
            return json({ connected: false, reason: 'env_locked', keys: envLocked });
        }

        // Pointing AUDIOURL at another server while Audiobookshelf libraries
        // exist would leave rows whose upstream ids belong to the old server:
        // the sync finds nothing and the items read as gone. Settings is the
        // place for a deliberate move, not the wizard. (A new key for the SAME
        // server does not change AUDIOURL and passes.)
        if ('AUDIOURL' in updates) {
            const sql = await aiDbService.getSql();
            const hasAbsLibraries =
                sql !== null &&
                (await getAllLibraryPaths(sql)).some((p) => p.provider === 'audiobookshelf');
            if (hasAbsLibraries) {
                return json({ connected: false, reason: 'libraries_exist' });
            }
        }

        const probe = await probeAudiobookshelf(url, apiKey);
        if (!probe.ok) {
            return json({
                connected: false,
                reason: probe.reason,
                ...(probe.reason === 'network' ? { error: probe.error } : {}),
                ...(probe.reason === 'http' ? { httpStatus: probe.httpStatus } : {}),
            });
        }

        await commitSettingsUpdates(updates, locals);

        const adminUsername = locals.user?.username ?? '';
        let userMatches:
            | AudiobookshelfUserMatches
            | {
                  userMatchStatus: 'unavailable';
                  adminUsername: string;
                  adminMatched: null;
              };
        try {
            const sql = await aiDbService.getSql();
            if (!sql) throw new Error('User database unavailable');
            userMatches = await checkAudiobookshelfUserMatches(sql, url, apiKey, adminUsername);
        } catch {
            userMatches = { userMatchStatus: 'unavailable', adminUsername, adminMatched: null };
        }

        return json({
            connected: true,
            libraryCount: probe.libraries.filter((l) => l.supported).length,
            ...userMatches,
        });
    }),
);
