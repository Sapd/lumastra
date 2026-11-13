// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cacheGet } from '$lib/server/cache/valkey';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { parseEmbyAuthHeader } from '$lib/server/proprietary/jellyfin-compat/middleware';
import type { JellyfinQuickConnectResult } from '$lib/server/proprietary/jellyfin-compat/types';
import {
    QC_SECRET_PREFIX,
    type QuickConnectData,
} from '$lib/server/proprietary/jellyfin-compat/quick-connect-utils';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit';

// security review 2026-09-12/13, C13/C24: `strict: true` makes the default
// key builder use the STRICT (non-spoofable) client IP instead of
// `getClientIp`, which honors an attacker-supplied `X-Forwarded-For` by
// implicit proxy trust when `TRUSTED_PROXY_IPS` is unset — rotating that
// header would otherwise get a fresh bucket per request and defeat the cap.
export const GET: RequestHandler = withValkeyRateLimit(30, 60, undefined, { strict: true })(async (
    event,
) => {
    const secret = getParam(event.url, 'Secret') ?? '';

    if (!secret) {
        return ApiResponses.badRequest('Missing secret parameter');
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

    const authHeader =
        event.request.headers.get('X-Emby-Authorization') ||
        event.request.headers.get('Authorization') ||
        '';
    const params = parseEmbyAuthHeader(authHeader);

    const result: JellyfinQuickConnectResult = {
        Secret: secret,
        Code: data.code,
        DateAdded: new Date().toISOString(),
        Authenticated: data.authenticated,
        DeviceId: params['DeviceId'] ?? '',
        DeviceName: params['Device'] ?? '',
        AppName: params['Client'] ?? '',
        AppVersion: params['Version'] ?? '',
    };

    return json(result);
});
