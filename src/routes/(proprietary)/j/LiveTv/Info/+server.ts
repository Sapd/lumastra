// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getLiveTvProvider } from '$lib/server/services/livetv/index';
import { hasLiveTvPermission } from '$lib/server/proprietary/jellyfin-compat/utils';
import { toJellyfinId } from '$lib/server/proprietary/jellyfin-compat/serializers/user';
import { JELLYFIN_EMULATED_VERSION } from '$lib/server/proprietary/jellyfin-compat/constants';

const logger = Logger.for('JellyfinCompat:LiveTv:Info');

/** The single Live TV "service" Lumastra presents (Jellyfin's own is named "Emby"). */
const SERVICE_NAME = 'Lumastra';

/**
 * GET /LiveTv/Info → LiveTvInfo. Apps read it to decide whether to show the
 * Live TV tab: IsEnabled when there is a lineup to watch, and the caller's own
 * id in EnabledUsers when they may watch it.
 *
 * Jellyfin lists EVERY user with Live TV access in EnabledUsers. Clients only
 * ever look for their own id there, so the list holds just the caller: the
 * roster of other accounts is not theirs to read. A user without Live TV
 * permission gets the disabled shape (200, not Jellyfin's 403) so the tab
 * simply stays hidden, matching how the sibling list routes answer them.
 */
export const GET: RequestHandler = withJellyfinAuth(async ({ locals }) => {
    if (!hasLiveTvPermission(locals.user)) {
        return json({ Services: [], IsEnabled: false, EnabledUsers: [] });
    }

    try {
        const provider = await getLiveTvProvider();
        const channels = await provider.getChannels();
        const isEnabled = channels.length > 0;
        return json({
            Services: isEnabled
                ? [
                      {
                          Name: SERVICE_NAME,
                          HomePageUrl: '',
                          Status: 'Ok',
                          StatusMessage: '',
                          Version: JELLYFIN_EMULATED_VERSION,
                          HasUpdateAvailable: false,
                          IsVisible: true,
                          Tuners: [],
                      },
                  ]
                : [],
            IsEnabled: isEnabled,
            EnabledUsers: isEnabled ? [toJellyfinId(locals.user.userId)] : [],
        });
    } catch (error) {
        logger.error('LiveTv/Info GET failed', error as Error);
        return ApiResponses.error('Failed to fetch live TV info');
    }
});
