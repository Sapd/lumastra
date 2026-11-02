// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: public — logout; must work without a valid session

/**
 * POST /api/auth/native/logout — revoke the current native session and clear the
 * cookie.
 *
 * Public surface (it only acts on the caller's own cookie). No-op for
 * forward-auth users (no session cookie) — those log out via their IdP/proxy.
 */

import { createHash } from 'node:crypto';
import { base } from '$app/paths';
import {
    authUnavailableResponse,
    isDependencyError,
} from '$lib/server/auth/dependency-unavailable.js';
import { problem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { readSessionCookie, clearSessionCookie } from '$lib/server/auth/native-session.js';
import { withClearSiteData } from '$lib/server/utils/clear-site-data.js';

const logger = Logger.for('NativeLogout');
const RETRY_COOKIE = 'lumastra_logout_retry';
const RETRY_PATH = `${base}/api/auth/native/logout`;

export const POST: RequestHandler = withErrorHandler(async ({ cookies }) => {
    const token = readSessionCookie(cookies);
    // A hash is a revocation-only capability: it is never accepted as a session
    // token. Keep failed revocations through a reload without keeping the browser signed in.
    const receipt = cookies.get(RETRY_COOKIE) ?? '';
    const pending = /^(?:[a-f0-9]{64})(?:\.[a-f0-9]{64})*$/.test(receipt) ? receipt.split('.') : [];
    const currentHash = token ? createHash('sha256').update(token).digest('hex') : null;
    const failed: string[] = [];
    const errors: unknown[] = [];
    const revoke = async (hash: string, rawToken?: string): Promise<void> => {
        try {
            const service = getSessionService();
            if (rawToken) await service.revoke(rawToken);
            else await service.revokeByTokenHash(hash);
        } catch (error) {
            logger.warn('Native logout: session revocation failed; retry required', {
                error: String(error),
            });
            failed.push(hash);
            errors.push(error);
        }
    };
    try {
        if (token && currentHash) await revoke(currentHash, token);
        for (const hash of new Set(pending)) {
            if (hash !== currentHash) await revoke(hash);
        }
    } finally {
        clearSessionCookie(cookies);
    }
    if (failed.length > 0) {
        cookies.set(RETRY_COOKIE, failed.join('.'), {
            path: RETRY_PATH,
            httpOnly: true,
            sameSite: 'strict',
            // At least as long as the maximum native-session lifetime. A failed
            // logout must not discard its retry receipt while that session is live.
            maxAge: 365 * 24 * 60 * 60,
        });
        return withClearSiteData(
            errors.every(isDependencyError)
                ? authUnavailableResponse()
                : problem('internal_error', {
                      error: 'Could not revoke the session. Please retry sign out.',
                  }),
        );
    }
    cookies.delete(RETRY_COOKIE, { path: RETRY_PATH });
    return withClearSiteData(json({ redirect: '/login' }));
});
