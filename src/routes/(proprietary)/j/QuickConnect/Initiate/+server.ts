// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { randomBytes, randomInt } from 'crypto';
import { storeQuickConnectRequest } from '$lib/server/proprietary/jellyfin-compat/quick-connect-store';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import type { JellyfinQuickConnectResult } from '$lib/server/proprietary/jellyfin-compat/types';
import { parseEmbyAuthHeader } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:QuickConnect');

// Swiftfin uses GET, Android TV uses POST
const handler: RequestHandler = async (event) => {
    const secret = randomBytes(16).toString('hex'); // 32-char hex
    let code = ''; // Reserved atomically below; never overwrite a pending code.

    const authHeader =
        event.request.headers.get('X-Emby-Authorization') ||
        event.request.headers.get('Authorization') ||
        '';
    const params = parseEmbyAuthHeader(authHeader);

    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = String(randomInt(100000, 1000000));
            const data = JSON.stringify({
                code: candidate,
                authenticated: false,
                userId: null,
                username: null,
                isAdmin: false,
                groups: [],
                displayName: null,
            });
            if (await storeQuickConnectRequest(candidate, secret, data)) {
                code = candidate;
                break;
            }
        }
        if (!code) throw new Error('Quick Connect code space unavailable');
    } catch (err) {
        logger.error(
            'Failed to store Quick Connect session in Valkey',
            err instanceof Error ? err : new Error(String(err)),
        );
        return new Response(JSON.stringify({ error: 'Session storage unavailable' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    logger.info('Quick Connect initiated');

    const result: JellyfinQuickConnectResult = {
        Secret: secret,
        Code: code,
        DateAdded: new Date().toISOString(),
        Authenticated: false,
        DeviceId: params['DeviceId'] ?? '',
        DeviceName: params['Device'] ?? '',
        AppName: params['Client'] ?? '',
        AppVersion: params['Version'] ?? '',
    };

    return json(result);
};

// Quick Connect Initiate is a public endpoint — the device has no token yet.
// Approval requires a signed-in user; authentication exchanges only the secret.
// Rate-limited per-IP (30/min, matching QuickConnect/Connect) so it can't be
// flooded to exhaust the 1M 6-digit code space or churn Valkey keys.
//
// security review 2026-09-12, C13: `strict: true` makes the default key
// builder use the STRICT (non-spoofable) client IP instead of `getClientIp`,
// which honors an attacker-supplied `X-Forwarded-For` by implicit proxy trust
// when `TRUSTED_PROXY_IPS` is unset — rotating that header would otherwise
// get a fresh bucket per request and defeat the cap.
export const GET: RequestHandler = withValkeyRateLimit(30, 60, undefined, { strict: true })(
    handler,
);
export const POST: RequestHandler = withValkeyRateLimit(30, 60, undefined, { strict: true })(
    handler,
);
