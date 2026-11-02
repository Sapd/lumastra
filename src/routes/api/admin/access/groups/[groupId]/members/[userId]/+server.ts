// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { RequestEvent } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/access/groups/[id]/members/[userId].js';
const handlers = mount(def, { surface: 'internal' });
function normalize(event: RequestEvent): void {
    event.params.id = event.params.groupId;
}
export const PUT = requireAdmin(async (event: RequestEvent): Promise<Response> => {
    normalize(event);
    return handlers.PUT!(event);
});
export const DELETE = requireAdmin(async (event: RequestEvent): Promise<Response> => {
    normalize(event);
    return handlers.DELETE!(event);
});
