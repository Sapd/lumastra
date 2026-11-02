// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/auth/native/change-password — a logged-in NATIVE user changes their
 * own password.
 *
 * NOT public: routes through normal auth (session populator sets locals.user).
 * Only meaningful for native-session users — forward-auth/IdP-managed users have
 * no Lumastra password and get a clear no-op message. On success the user's other
 * sessions are revoked and this device gets a fresh rotated session cookie.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { changeOwnPassword } from '$lib/server/services/native-auth.service.js';
import { setSessionCookie, sessionMaxAgeSeconds } from '$lib/server/auth/native-session.js';
import { isRecord, toString } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/auth/native/change-password';

export const POST: RequestHandler = requireAuth(
    withErrorHandler(async (event) => {
        const { request, locals, cookies } = event;

        // Only native-session users have a Lumastra-managed password. Forward-auth
        // users authenticate via their identity provider — nothing to change here.
        if (locals.authMethod !== 'session') {
            return ApiResponses.badRequest(
                'Your account is managed by your identity provider. Change your password there.',
                undefined,
                ENDPOINT,
            );
        }

        const ip = getClientIp(event);
        const username = locals.user.username;

        // Per-user attempt cap (defends the current-password check).
        const gate = await checkRateLimit(`changepw:${username.toLowerCase()}`, 10, 15 * 60);
        if (!gate.allowed) return ApiResponses.rateLimited(gate.resetAt * 1000, ENDPOINT);

        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body');
        }
        if (!isRecord(body)) return ApiResponses.badRequest('Invalid request body');

        const currentPassword = toString(body.currentPassword);
        const newPassword = toString(body.newPassword);
        if (!currentPassword || !newPassword) {
            return ApiResponses.badRequest(
                'Current and new password are required',
                undefined,
                ENDPOINT,
            );
        }

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.aiDatabaseUnavailable(ENDPOINT);

        const result = await changeOwnPassword(sql, {
            username,
            currentPassword,
            newPassword,
            userAgent: request.headers.get('user-agent'),
            ip,
        });

        if (!result.ok) {
            return ApiResponses.error(result.message, undefined, result.status, ENDPOINT);
        }

        setSessionCookie(
            cookies,
            result.session.token,
            sessionMaxAgeSeconds(result.session.expiresAt),
        );
        return json({ changed: true });
    }),
);
