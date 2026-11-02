// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import {
    parseOptionalInt,
    parsePlaystateCommand,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    playstateMessage,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import { nativePlaystate } from '$lib/server/proprietary/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.SendPlaystateCommand — Stop, Pause, Unpause,
 * NextTrack, PreviousTrack, Seek, Rewind, FastForward, PlayPause.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const command = parsePlaystateCommand(event.params.command);
        if (!command) return badRequest('Unknown playstate command');
        const seekPositionTicks = parseOptionalInt(getParam(event.url, 'seekPositionTicks'));
        if (seekPositionTicks === null) {
            return badRequest('seekPositionTicks must be an integer');
        }
        return withControllableTarget(
            event,
            async ({ target, caller }) => {
                await deliver(
                    target,
                    playstateMessage({
                        Command: command,
                        SeekPositionTicks: seekPositionTicks ?? null,
                        // Jellyfin overwrites the client's value with the caller.
                        ControllingUserId: controllingUserId(caller),
                    }),
                );
                return noContent();
            },
            (native) => nativePlaystate(native, command, seekPositionTicks),
        );
    },
    { mode: 'write' },
);
