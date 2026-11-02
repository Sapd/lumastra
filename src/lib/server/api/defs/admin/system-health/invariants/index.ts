// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/system-health/invariants
 *
 * Internal (cookie/forward-auth) facade for the system-health invariants endpoint.
 * Delegates to the same handler as /api/v1/admin/system-health/invariants —
 * authenticate() falls back to the logged-in admin's cookie/forward-auth
 * identity (internalAdminAuth) on this internal surface.
 *
 * The handler performs its own fine-grained auth, so using raw:true to pass
 * the event directly through without interfering.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { handleHealthInvariants } from '$lib/server/admin/health-invariants.handler.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    raw: true,
    handlers: {
        GET: async (event, _ctx) => handleHealthInvariants(event),
    },
});
