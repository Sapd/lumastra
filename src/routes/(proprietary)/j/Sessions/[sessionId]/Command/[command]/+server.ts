// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { parseGeneralCommandType } from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    generalCommandMessage,
    liveTvCommandDenial,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import { nativeGeneralCommand } from '$lib/server/proprietary/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.SendGeneralCommand — a GeneralCommand with no arguments
 * (GoHome, ToggleMute, VolumeUp, …).
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const name = parseGeneralCommandType(event.params.command);
        if (!name) return badRequest('Unknown command');
        return withControllableTarget(
            event,
            async ({ target, caller }) => {
                const denied = await liveTvCommandDenial(name, target.username);
                if (denied) return denied;
                await deliver(
                    target,
                    generalCommandMessage({
                        Name: name,
                        ControllingUserId: controllingUserId(caller),
                        Arguments: {},
                    }),
                );
                return noContent();
            },
            (native) =>
                nativeGeneralCommand(native, {
                    Name: name,
                    ControllingUserId: controllingUserId(native.caller),
                    Arguments: {},
                }),
        );
    },
    { mode: 'write' },
);
