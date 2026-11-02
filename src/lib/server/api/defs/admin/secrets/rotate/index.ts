// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/secrets/rotate
 *
 * Internal (cookie/forward-auth) facade for the master-key rotation endpoint.
 * Delegates to the same handler as /api/v1/admin/secrets/rotate — authenticate()
 * in that handler falls back to the logged-in admin's cookie/forward-auth
 * identity (internalAdminAuth) on this internal surface.
 *
 * The handler performs its own fine-grained auth (tasks:admin scope), so
 * using raw:true to pass the event directly through without interfering.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { handleSecretsRotate } from '$lib/server/admin/secrets-rotate.handler.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    raw: true,
    handlers: {
        POST: async (event, _ctx) => handleSecretsRotate(event),
    },
});
