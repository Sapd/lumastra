// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam, getParamAll } from '$lib/server/proprietary/jellyfin-compat/utils';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    parseItemIds,
    parseOptionalInt,
    parsePlayCommand,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    itemsPlayableBy,
    playMessage,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import { nativePlay } from '$lib/server/proprietary/jellyfin-compat/remote-control/native-devices';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.Play — tell a device to play items
 * ("Play on…" / cast). Sent to the device's socket as a `Play` message.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { url } = event;
        const playCommand = parsePlayCommand(getParam(url, 'playCommand'));
        if (!playCommand) return badRequest('playCommand is required');
        const itemIds = parseItemIds(getParamAll(url, 'itemIds'));
        if (!itemIds || itemIds.length === 0) {
            return badRequest('itemIds must be 1 to 500 item ids');
        }
        const ints: Record<string, number | undefined> = {};
        for (const name of [
            'startPositionTicks',
            'audioStreamIndex',
            'subtitleStreamIndex',
            'startIndex',
        ]) {
            const v = parseOptionalInt(getParam(url, name));
            if (v === null) return badRequest(`${name} must be an integer`);
            ints[name] = v;
        }
        const mediaSourceId = getParam(url, 'mediaSourceId');

        return withControllableTarget(
            event,
            async ({ sql, target, caller }) => {
                if (!(await itemsPlayableBy(sql, itemIds, caller, target))) {
                    return ApiResponses.notFound('Item not found');
                }
                let ids = itemIds;
                // Jellyfin resolves these server-side and always sends PlayNow.
                // Shuffle is done here; an instant mix needs the music-mix
                // generator, so the seed items are sent as-is.
                if (playCommand === 'PlayShuffle') ids = shuffle(ids);
                await deliver(
                    target,
                    playMessage({
                        ItemIds: ids,
                        StartPositionTicks: ints.startPositionTicks ?? null,
                        PlayCommand:
                            playCommand === 'PlayShuffle' || playCommand === 'PlayInstantMix'
                                ? 'PlayNow'
                                : playCommand,
                        ControllingUserId: controllingUserId(caller),
                        SubtitleStreamIndex: ints.subtitleStreamIndex ?? null,
                        AudioStreamIndex: ints.audioStreamIndex ?? null,
                        MediaSourceId: mediaSourceId || null,
                        StartIndex: ints.startIndex ?? null,
                    }),
                );
                return noContent();
            },
            (native) =>
                nativePlay(native, {
                    playCommand,
                    itemIds,
                    ...(ints.startIndex !== undefined ? { startIndex: ints.startIndex } : {}),
                    ...(ints.startPositionTicks !== undefined
                        ? { startPositionTicks: ints.startPositionTicks }
                        : {}),
                }),
        );
    },
    { mode: 'write' },
);

function shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
