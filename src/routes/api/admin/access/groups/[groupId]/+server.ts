// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// authz: delegated to mount(def) — def carries { kind: 'admin' } auth guard enforced by mount()

/**
 * /api/admin/access/groups/[groupId] — SPA-internal surface mount.
 * Contract: GET/PATCH → { group }; DELETE → { deleted: true }; errors → problem+json.
 *
 * The def reads params.id or params.groupId (normalised inside the handler),
 * but SvelteKit populates params.groupId from this route's [groupId] segment.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/access/groups/[id]/index.js';

// Mount with surface='internal'. The def reads event.params.id or event.params.groupId.
// Patch params so the def handler receives 'id' regardless of route param name.
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

export const PATCH = async (event: RequestEvent): Promise<Response> => {
    normalizeEvent(event);
    return handlers.PATCH!(event);
};

export const DELETE = async (event: RequestEvent): Promise<Response> => {
    normalizeEvent(event);
    return handlers.DELETE!(event);
};
