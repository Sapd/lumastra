// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { json, type RequestHandler } from '@sveltejs/kit';
import { cacheGet, cacheDel } from '$lib/server/cache/valkey';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { createSession } from '$lib/server/proprietary/jellyfin-compat/auth';
import { hasGroupPermission } from '$lib/server/auth';
import { config } from '$lib/server/config';
import { serializeUser } from '$lib/server/proprietary/jellyfin-compat/serializers/user';
import { loadUserPlaybackPreferences } from '$lib/server/proprietary/jellyfin-compat/user-playback-preferences';
import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import { parseEmbyAuthHeader } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import type { JellyfinAuthResponse } from '$lib/server/proprietary/jellyfin-compat/types';
import { Logger } from '$lib/server/utils/logger';
import { readBoundedJson, isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import {
    QC_SECRET_PREFIX,
    QC_CODE_PREFIX,
    type QuickConnectData,
} from '$lib/server/proprietary/jellyfin-compat/quick-connect-utils';
import { clampJellyfinDeviceId } from '$lib/server/proprietary/jellyfin-compat/playback-utils';

const logger = Logger.for('JellyfinCompat:QuickConnect');

// A Quick Connect secret is 32 hex chars; the body is a one-field JSON object.
const MAX_QC_BODY_BYTES = 4 * 1024;
const MAX_QC_SECRET_LENGTH = 128;

const handler: RequestHandler = async (event) => {
    let body: { Secret?: unknown };
    try {
        body = (await readBoundedJson(event.request, MAX_QC_BODY_BYTES)) as { Secret?: unknown };
    } catch (err) {
        if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
        return ApiResponses.badRequest('Invalid JSON body');
    }
    const secret =
        typeof body.Secret === 'string'
            ? body.Secret
            : typeof (body as Record<string, unknown>).secret === 'string'
              ? ((body as Record<string, unknown>).secret as string)
              : '';

    if (!secret) {
        return ApiResponses.badRequest('Secret is required');
    }
    // The secret becomes a Valkey key; a real one is 32 chars.
    if (secret.length > MAX_QC_SECRET_LENGTH) {
        return ApiResponses.badRequest('Invalid Secret');
    }

    const raw = await cacheGet(QC_SECRET_PREFIX + secret);
    if (!raw) {
        return ApiResponses.notFound('Quick Connect session');
    }

    let data: QuickConnectData;
    try {
        data = JSON.parse(raw) as QuickConnectData;
    } catch {
        return ApiResponses.error('Corrupted Quick Connect session');
    }

    if (!data.authenticated || !data.userId || !data.username) {
        return ApiResponses.unauthorized('Quick Connect not yet authorized');
    }

    const authHeader =
        event.request.headers.get('X-Emby-Authorization') ||
        event.request.headers.get('Authorization') ||
        '';
    const params = parseEmbyAuthHeader(authHeader);

    const token = await createSession({
        origin: 'quick_connect',
        approvedBySessionToken: data.approvedBySessionToken,
        userId: data.userId,
        username: data.username,
        isAdmin: data.isAdmin,
        groups: data.groups,
        displayName: data.displayName,
        deviceId: clampJellyfinDeviceId(params['DeviceId']),
        deviceName: params['Device'] ?? '',
        clientName: params['Client'] ?? '',
        clientVersion: params['Version'] ?? '',
        createdAt: new Date().toISOString(),
    });

    // Clean up Quick Connect keys (single-use) regardless of outcome — a
    // secret that just failed the disabled/deleted check must not be
    // replayable for a second attempt either.
    await Promise.allSettled([
        cacheDel(QC_SECRET_PREFIX + secret),
        cacheDel(QC_CODE_PREFIX + data.code),
    ]);

    if (!token) {
        // SECURITY (review 2026-09-16, C5): createSession() denies the mint
        // for a disabled/deleted/unresolvable account. Without this check,
        // a disable landing inside the Quick Connect approval window did not
        // stop a fresh 30-day /j session from being minted here — this route
        // had no `users` query of its own (see createSession's own comment
        // for why the check lives there instead of here).
        logger.info('Quick Connect authentication denied — account deactivated', {
            username: data.username,
            deviceName: params['Device'],
        });
        return ApiResponses.unauthorized('Account deactivated');
    }

    logger.info('Quick Connect authentication completed', {
        username: data.username,
        deviceName: params['Device'],
    });

    const playback = await loadUserPlaybackPreferences(data.userId);
    const user = serializeUser(
        {
            id: data.userId,
            username: data.username,
            is_admin: data.isAdmin,
            display_name: data.displayName,
            hasLiveTvPermission:
                (await userAllowsLiveTv(data.username)) &&
                (data.isAdmin || hasGroupPermission(data.groups ?? [], config.LIVETV_GROUPS)),
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

// Anonymous endpoint (the device has no token yet): per-IP cap like
// QuickConnect/Initiate, on the strict (non-spoofable) client IP.
export const POST: RequestHandler = withValkeyRateLimit(30, 60, undefined, { strict: true })(
    withErrorHandler(handler),
);
