// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getParam, getParamAll } from '$lib/server/jellyfin-compat/utils';
import {
    filterGeneralCommands,
    filterMediaTypes,
    parseBool,
} from '$lib/server/jellyfin-compat/remote-control/protocol';
import { reportCapabilities } from '$lib/server/jellyfin-compat/remote-control/capabilities';

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
