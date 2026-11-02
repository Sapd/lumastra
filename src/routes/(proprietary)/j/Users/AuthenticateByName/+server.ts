// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { readBoundedJson, isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    withValkeyRateLimit,
    checkRateLimit,
    peekRateLimit,
    resetRateLimit,
} from '$lib/server/middleware/valkey-rate-limit';
import { parseEmbyAuthHeader } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { validatePassword, createSession } from '$lib/server/proprietary/jellyfin-compat/auth';
import { hasGroupPermission } from '$lib/server/auth';
import { config } from '$lib/server/config';
import { serializeUser } from '$lib/server/proprietary/jellyfin-compat/serializers/user';
import { loadUserPlaybackPreferences } from '$lib/server/proprietary/jellyfin-compat/user-playback-preferences';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import type { JellyfinAuthResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import { Logger } from '$lib/server/utils/logger';
import { clampJellyfinDeviceId } from '$lib/server/proprietary/jellyfin-compat/playback-utils';

const logger = Logger.for('JellyfinCompat:AuthByName');

// security review 2026-09-13, C24: failures per username — targeted-account
// lockout, IP-independent (mirrors /api/auth/native/login's USER_FAIL_LIMIT).
// Each AuthenticateByName attempt costs a full scrypt verify (N=65536) even
// for an unknown user, and the per-IP cap below can be outrun by a
// distributed attacker spreading requests across peers, so a second bucket
// keyed only on the (lowercased) username is required. Kept equal to
// /api/auth/native/login's USER_FAIL_LIMIT so the two surfaces present the
// same lockout posture for the same account.
const USER_FAIL_LIMIT = 10;
const USER_FAIL_WINDOW = 15 * 60;

// Username + password + a few client fields; anything bigger is not a login.
const MAX_AUTH_BODY_BYTES = 16 * 1024;

const handler: RequestHandler = async (event) => {
    let body: Record<string, unknown>;
    try {
        body = (await readBoundedJson(event.request, MAX_AUTH_BODY_BYTES)) as Record<
            string,
            unknown
        >;
    } catch (err) {
        if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
        return ApiResponses.badRequest('Invalid JSON body');
    }

    // Jellyfin SDK sends Username/Pw, some clients may send Name/Password
    // Case-insensitive username — clients may send "Testuser" but DB has "testuser"
    const username = (
        typeof body.Username === 'string'
            ? body.Username
            : typeof body.Name === 'string'
              ? body.Name
              : ''
    )
        .trim()
        .toLowerCase();
    // Strip spaces from password — we display as "xxxx xxxx" but hash without spaces
    const rawPassword =
        typeof body.Pw === 'string'
            ? body.Pw
            : typeof body.Password === 'string'
              ? body.Password
              : '';
    const password = rawPassword.replace(/\s/g, '');

    logger.info('Auth attempt', {
        username,
        hasPassword: password.length > 0,
        bodyKeys: Object.keys(body).join(','),
    });

    if (!username) {
        return ApiResponses.badRequest('Username is required');
    }

    const authHeader =
        event.request.headers.get('X-Emby-Authorization') ||
        event.request.headers.get('Authorization') ||
        '';
    const params = parseEmbyAuthHeader(authHeader);

    // Per-username lockout: read the failure counter WITHOUT incrementing it (a
    // successful login must not erode a legitimate user's own budget) and
    // refuse before the expensive scrypt verify if it's already exhausted.
    const userKey = `jf:authbyname:user:${username}`;
    const userGate = await peekRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
    if (!userGate.allowed) {
        return ApiResponses.rateLimited(userGate.resetAt * 1000, '/j/Users/AuthenticateByName');
    }

    const userResult = await validatePassword(username, password);
    if (!userResult) {
        // Count the failure against the per-username lockout (only failures count).
        await checkRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
        return ApiResponses.unauthorized('Invalid username or password');
    }

    // Success — clear the failure counter so prior typos don't linger.
    await resetRateLimit(userKey, USER_FAIL_WINDOW);

    const token = await createSession(
        {
            userId: userResult.userId,
            username: userResult.username,
            isAdmin: userResult.isAdmin,
            groups: userResult.groups,
            displayName: userResult.displayName,
            deviceId: clampJellyfinDeviceId(params['DeviceId']),
            deviceName: params['Device'] ?? '',
            clientName: params['Client'] ?? '',
            clientVersion: params['Version'] ?? '',
            createdAt: new Date().toISOString(),
        },
        userResult,
    );

    if (!token) {
        // Includes password replacement/revocation during verification.
        logger.warn('Auth denied at session mint', { username });
        return ApiResponses.unauthorized('Invalid username or password');
    }

    const playback = await loadUserPlaybackPreferences(userResult.userId);
    const user = serializeUser(
        {
            id: userResult.userId,
            username: userResult.username,
            is_admin: userResult.isAdmin,
            display_name: userResult.displayName,
            hasLiveTvPermission:
                (await userAllowsLiveTv(userResult.username)) &&
                (userResult.isAdmin || hasGroupPermission(userResult.groups, config.LIVETV_GROUPS)),
        },
        playback,
    );

    const response: JellyfinAuthResponse = {
        AccessToken: token,
        ServerId: JELLYFIN_SERVER_ID,
        User: user,
        SessionInfo: {
            UserId: user.Id,
            UserName: user.Name,
            ServerId: JELLYFIN_SERVER_ID,
            DeviceId: params['DeviceId'] ?? '',
            DeviceName: params['Device'] ?? '',
            Client: params['Client'] ?? '',
            ApplicationVersion: params['Version'] ?? '',
            Id: token.slice(0, 32),
            PlayState: {
                IsPaused: false,
                IsMuted: false,
                CanSeek: false,
                RepeatMode: 'RepeatNone',
                PlaybackOrder: 'Default',
            },
            IsActive: true,
            SupportsRemoteControl: false,
            SupportsMediaControl: false,
            HasCustomDeviceName: false,
            PlayableMediaTypes: ['Audio', 'Video'],
            SupportedCommands: [],
            AdditionalUsers: [],
            NowPlayingQueue: [],
            NowPlayingQueueFullItems: [],
            LastActivityDate: new Date().toISOString(),
            LastPlaybackCheckIn: '0001-01-01T00:00:00.0000000Z',
        },
    };

    return json(response);
};

// security review 2026-09-12/13, C13/C24: `strict: true` makes the default
// key builder use the STRICT (non-spoofable) client IP instead of
// `getClientIp`, which honors an attacker-supplied `X-Forwarded-For` by
// implicit proxy trust when `TRUSTED_PROXY_IPS` is unset — rotating that
// header would otherwise get a fresh bucket per request and defeat the cap.
export const POST = withValkeyRateLimit(10, 60, undefined, { strict: true })(
    withErrorHandler(handler),
);
