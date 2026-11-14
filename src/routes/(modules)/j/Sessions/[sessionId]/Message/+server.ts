// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { messageCommandFromBody } from '$lib/server/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    generalCommandMessage,
} from '$lib/server/jellyfin-compat/remote-control/commands';
import { nativeGeneralCommand } from '$lib/server/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    readJsonBody,
    withControllableTarget,
} from '$lib/server/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.SendMessageCommand — a MessageCommand body,
 * delivered as a `DisplayMessage` GeneralCommand (Header, Text, TimeoutMs).
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const caller = event.locals.user;
        if (!caller) return ApiResponses.unauthorized();
        const command = messageCommandFromBody(
            await readJsonBody(event.request),
            controllingUserId(caller),
        );
        if (!command)
            return badRequest(
                'Body must be a MessageCommand with Text (Text and Header up to 4 KB)',
            );
        return withControllableTarget(
            event,
            async ({ target }) => {
                await deliver(target, generalCommandMessage(command));
                return noContent();
            },
            (native) => nativeGeneralCommand(native, command),
        );
    },
    { mode: 'write' },
);
