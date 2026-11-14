// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    badRequest,
    noContent,
    withControllableTarget,
} from '$lib/server/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.AddUserToSession / RemoveUserFromSession.
 *
 * Lumastra sessions belong to exactly one user (play history and watch state
 * are per user, with no "additional users"), so both are accepted as no-ops
 * on a session the caller may control: the app's request succeeds and the
 * session's `AdditionalUsers` stays empty.
 */
const handler = async (event: Parameters<RequestHandler>[0]): Promise<Response> => {
    if (!isUuid(event.params.userId)) return badRequest('userId must be a Guid');
    return withControllableTarget(event, async () => noContent());
};

export const POST: RequestHandler = withJellyfinAuth(
    (event) => handler(event as Parameters<RequestHandler>[0]),
    { mode: 'write' },
);
export const DELETE: RequestHandler = withJellyfinAuth(
    (event) => handler(event as Parameters<RequestHandler>[0]),
    { mode: 'write' },
);
