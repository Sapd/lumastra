// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { ApiResponses } from '$lib/server/utils/api-responses';
import {
    parseBaseItemKind,
    parseItemIds,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    controllingUserId,
    deliver,
    generalCommandMessage,
    itemsPlayableBy,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.DisplayContent — make a device open an item's
 * page. Sent as a `DisplayContent` GeneralCommand (ItemId, ItemName, ItemType).
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { url } = event;
        const itemType = parseBaseItemKind(getParam(url, 'itemType'));
        if (!itemType) return badRequest('itemType is required');
        const rawItemId = getParam(url, 'itemId') ?? '';
        const itemIds = parseItemIds([rawItemId]);
        if (!itemIds || itemIds.length !== 1) {
            return badRequest('itemId is required');
        }
        const itemName = getParam(url, 'itemName');
        if (itemName === null) return badRequest('itemName is required');

        return withControllableTarget(event, async ({ sql, target, caller }) => {
            if (!(await itemsPlayableBy(sql, itemIds, caller, target))) {
                return ApiResponses.notFound('Item not found');
            }
            await deliver(
                target,
                generalCommandMessage({
                    Name: 'DisplayContent',
                    ControllingUserId: controllingUserId(caller),
                    Arguments: { ItemId: itemIds[0], ItemName: itemName, ItemType: itemType },
                }),
            );
            return noContent();
        });
    },
    { mode: 'write' },
);
