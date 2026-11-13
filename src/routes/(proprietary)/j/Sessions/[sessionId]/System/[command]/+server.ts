// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { parseGeneralCommandType } from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    generalCommandMessage,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.SendSystemCommand — same as /Command/{command};
 * Jellyfin binds it to GeneralCommandType too.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const name = parseGeneralCommandType(event.params.command);
        if (!name) return badRequest('Unknown command');
        return withControllableTarget(event, async ({ target, caller }) => {
            await deliver(
                target,
                generalCommandMessage({
                    Name: name,
                    ControllingUserId: controllingUserId(caller),
                    Arguments: {},
                }),
            );
            return noContent();
        });
    },
    { mode: 'write' },
);
