// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// authz: delegated to mount(def) — def carries { kind: 'admin' } auth guard enforced by mount()

/**
 * /api/admin/access/groups/[groupId]/members — SPA-internal surface mount.
 * Contract: GET → { items, page }; mutations address members/{userId}.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/access/groups/[id]/members.js';

// Normalize params.groupId → params.id so the def handler can read event.params.id.
function normalizeEvent(event: RequestEvent): void {
    if (!event.params.id && event.params.groupId) {
        (event.params as Record<string, string>).id = event.params.groupId;
    }
}

const handlers = mount(def, { surface: 'internal' });

export const GET = async (event: RequestEvent): Promise<Response> => {
    normalizeEvent(event);
    return handlers.GET!(event);
};
