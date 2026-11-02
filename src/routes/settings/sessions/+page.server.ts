// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';
import { getDb } from '$lib/server/database/connection';
import { DeviceSchema, DevicesListResponseSchema } from '$lib/schemas/devices';
import { getUserDevices } from '$lib/server/services/user-devices.service';
import { listUserSessions } from '$lib/server/database/queries/user-sessions.queries';
import { readSessionCookie } from '$lib/server/auth/native-session';
import {
    hashSessionToken,
    toWebLoginViews,
    type WebLoginView,
} from '$lib/server/utils/web-logins-util';
import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';

/**
 * Loader for the unified `/settings/sessions` page ("Sessions & Devices").
 * Combines three independent sources:
 *  - device tokens (Jellyfin + OAuth) — combine block copied verbatim from
 *    `settings/devices/+page.server.ts` so both routes stay in lockstep
 *  - native web-login sessions (`user_sessions`), shaped via the shared
 *    `web-logins-util` helper (also used by `/api/user/sessions`)
 *
 * Nav registration + the `/settings/devices` -> `/settings/sessions` redirect
 * are in place (the `sessions` section is registered in `settings-sections.ts`
 * and `/settings/devices` 307-redirects here). This loader is the redirect
 * target, so it deliberately has no section-visibility guard of its own — that
 * would bounce the route away.
 */
export const load: PageServerLoad = async ({ locals, cookies }) => {
    const deviceAuthEnabled = features.deviceAuth;
    const userId = locals.user?.userId;
    const sql = getDb();
    if (!userId || !sql) {
        return {
            deviceSessions: DevicesListResponseSchema.parse({
                items: [],
                page: { limit: 0, offset: 0, hasMore: false, total: 0 },
            }),
            deviceAuthEnabled,
            webLogins: [] as WebLoginView[],
            viewerUserId: userId,
        };
    }

    // --- device tokens (copied verbatim from settings/devices/+page.server.ts) ---
    let deviceSessions: UserDeviceInfo[] = [];
    if (deviceAuthEnabled) {
        try {
            // Single read model — see services/user-devices.service.ts.
            // Deliberately reads no Jellyfin table: this page previously merged
            // user_provider_device_tokens first, so its stored credential string
            // ("Lumastra - Wohnzimmer") shadowed the real device name here, and the
            // list changed shape depending on whether Jellyfin sync was enabled.
            deviceSessions = (await getUserDevices(sql, userId, { withPresence: true })).map(
                (device) => DeviceSchema.parse(device),
            );
        } catch {
            deviceSessions = [];
        }
    }

    // --- native web logins ---
    let webLogins: WebLoginView[];
    try {
        const rows = await listUserSessions(sql, userId);
        const current = readSessionCookie(cookies);
        webLogins = toWebLoginViews(rows, current ? hashSessionToken(current) : null);
    } catch {
        webLogins = [];
    }

    return {
        deviceSessions: DevicesListResponseSchema.parse({
            items: deviceSessions,
            page: {
                limit: deviceSessions.length,
                offset: 0,
                hasMore: false,
                total: deviceSessions.length,
            },
        }),
        deviceAuthEnabled,
        webLogins,
        viewerUserId: userId,
    };
};
