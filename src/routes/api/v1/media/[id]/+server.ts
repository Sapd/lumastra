// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/v1/media/{id}
 *
 * GET    — polymorphic detail spine (user auth); §8.6 contract.
 *          Accepts ?include=user,playback for per-user watch-state.
 *          Composite-id resolution via ?externalId=provider:id:type or UUID path param.
 * DELETE — permanently remove a media item; scope: media:admin
 */

import type { RequestEvent } from '@sveltejs/kit';
import { mount, enforce } from '$lib/server/api/mount.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { def } from '$lib/server/api/defs/catalog/media-id.js';
import { DELETE as adminDELETE } from '../../../../api/admin/media/[id]/+server.js';

const mounted = mount(def, { surface: 'v1' });
export const GET = mounted.GET;

export const DELETE = async (event: RequestEvent): Promise<Response> => {
    const err = await enforce({ kind: 'scope', anyOf: ['media:admin'] }, event);
    if (err) return err;
    return delegateToAdmin(event, adminDELETE!);
};
