// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    generalCommandFromBody,
    generalCommandItemIds,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    generalCommandMessage,
    liveTvCommandDenial,
    itemsPlayableBy,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import { nativeGeneralCommand } from '$lib/server/proprietary/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    readJsonBody,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/** Jellyfin SessionController.SendFullGeneralCommand — a GeneralCommand body with Arguments. */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const body = await readJsonBody(event.request);
        const caller = event.locals.user;
        if (!caller) return ApiResponses.unauthorized();
        const command = generalCommandFromBody(body, controllingUserId(caller));
        if (!command) {
            return badRequest(
                'Body must be a GeneralCommand with a known Name and at most 32 Arguments of up to 4 KB each',
            );
        }
        // DisplayContent, Play, PlayNext, …: the items must be visible to the
        // caller and the target's owner, as /Playing and /Viewing require.
        const itemIds = generalCommandItemIds(command);
        if (!itemIds) return badRequest('Arguments.ItemId(s) must be 1 to 500 item ids');
        return withControllableTarget(
            event,
            async ({ sql, target }) => {
                const denied = await liveTvCommandDenial(command.Name, target.username);
                if (denied) return denied;
                if (itemIds.length > 0 && !(await itemsPlayableBy(sql, itemIds, caller, target))) {
                    return ApiResponses.notFound('Item not found');
                }
                await deliver(target, generalCommandMessage(command));
                return noContent();
            },
            (native) => nativeGeneralCommand(native, command),
        );
    },
    { mode: 'write' },
);
