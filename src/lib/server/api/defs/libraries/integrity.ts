// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/libraries/integrity.ts — GET /api/v1/libraries/integrity
 *
 * File-integrity scan results (open integrity violations + per-rule counts).
 * Requires `library:admin` scope; delegates to the internal admin read path.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/libraries/integrity/`
 * `+server.ts`, which did `enforce({kind:'scope', anyOf:['library:admin']})`
 * then `delegateToAdmin(event, adminGET)`. Behaviour is IDENTICAL:
 *   - mount() runs the very same `enforce()` with the same AuthSpec BEFORE the
 *     handler, so the 401/403 gate is byte-for-byte the same.
 *   - The handler still calls `delegateToAdmin(event, adminGET)` against the
 *     same admin handler → same response, same admin second-gate patch.
 *
 * This mirrors the established delegate-def pattern in defs/tasks/*.ts (which
 * likewise import the admin `+server.js` handler and delegate to it). v1-only:
 * HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/integrity/+server.js';
import { IntegrityViolationsResponseSchema } from '$lib/schemas/api-admin-library-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List open integrity violations',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: IntegrityViolationsResponseSchema,
                    description: 'Integrity violations list with per-rule counts',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
    },
});
