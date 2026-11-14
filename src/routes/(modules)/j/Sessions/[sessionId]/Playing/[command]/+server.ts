// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getParam } from '$lib/server/jellyfin-compat/utils';
import {
    parseOptionalInt,
    parsePlaystateCommand,
} from '$lib/server/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    playstateMessage,
} from '$lib/server/jellyfin-compat/remote-control/commands';
import { nativePlaystate } from '$lib/server/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/jellyfin-compat/remote-control/route-helpers';

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
