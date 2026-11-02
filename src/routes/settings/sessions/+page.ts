// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageLoad } from './$types';

/**
 * Pass-through loader for the universal `sessions` settings section (registered
 * in `settings-sections.ts`; `/settings/devices` now 307-redirects here). This
 * route is the redirect target, so it deliberately runs NO `settingsRedirectTarget`
 * check of its own — that would bounce the route away. It stays directly
 * reachable at `/settings/sessions` and just forwards the server load's data.
 */
export const load: PageLoad = async ({ data }) => {
    return {
        deviceSessions: data.deviceSessions,
        deviceAuthEnabled: data.deviceAuthEnabled,
        webLogins: data.webLogins,
        viewerUserId: data.viewerUserId,
    };
};
