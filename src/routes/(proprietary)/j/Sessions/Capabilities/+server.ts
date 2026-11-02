// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam, getParamAll } from '$lib/server/proprietary/jellyfin-compat/utils';
import {
    filterGeneralCommands,
    filterMediaTypes,
    parseBool,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import { reportCapabilities } from '$lib/server/proprietary/jellyfin-compat/remote-control/capabilities';

/**
 * Jellyfin SessionController.PostCapabilities — capabilities as query
 * parameters. Stored so `/Sessions` reports SupportsRemoteControl,
 * SupportedCommands and PlayableMediaTypes truthfully. Unknown enum values
 * are dropped (the SDK cannot decode them).
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { url } = event;
        return reportCapabilities(event, {
            playableMediaTypes: filterMediaTypes(getParamAll(url, 'playableMediaTypes')),
            supportedCommands: filterGeneralCommands(getParamAll(url, 'supportedCommands')),
            supportsMediaControl: parseBool(getParam(url, 'supportsMediaControl'), false),
        });
    },
    { pat: 'deny', mode: 'write' },
);
