// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/secrets/rotate-v1.ts — POST /api/v1/admin/secrets/rotate
 *
 * NAMING NOTE: this file is named `rotate-v1.ts` (NOT the convention path
 * `rotate.ts`/`rotate/index.ts`) because `defs/admin/secrets/rotate/index.ts`
 * already exists as a RELATED-but-DIFFERENT def: the internal (cookie/forward-
 * auth) facade for `/api/admin/secrets/rotate`, mounted with `{kind:'admin'}`
 * as an outer gate (appropriate for that surface, where the fine-grained
 * `tasks:admin` scope check inside `handleSecretsRotate` is redundant with an
 * already-admin cookie session).
 *
 * The ORIGINAL hand-written `/api/v1/admin/secrets/rotate` route had NO outer
 * gate at all — it called `handleSecretsRotate(event)` directly, which does its
 * own `authenticate()` + `requireScope(auth, 'tasks:admin')`. Reusing the
 * internal def's `{kind:'admin'}` outer gate here would be a behaviour
 * regression: it would reject a `tasks:admin`-scoped PAT/service token that
 * lacks the literal `admin` scope, which the original v1 route accepted. This
 * def therefore uses the narrower, byte-faithful `{kind:'scope',
 * anyOf:['tasks:admin']}` outer gate instead — mount()'s enforce() runs the
 * SAME authenticate()+scopeGranted() primitives as the handler's own check, so
 * the 401/403 contract is preserved exactly (the handler's inner check becomes
 * a harmless no-op re-validation, same as the library/scan.ts precedent).
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no new internal twin
 * (the existing `/api/admin/secrets/rotate` internal facade is untouched).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { handleSecretsRotate } from '$lib/server/admin/secrets-rotate.handler.js';
import { RotateSecretsSchema, V1RotateSecretsResponseSchema } from '$lib/schemas/api-v1';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Admin'],
            summary: 'Rotate task secrets',
            stability: 'beta',
            description:
                'Re-encrypts stored task secrets under a new master-key version. Requires `admin` scope.',
            body: RotateSecretsSchema,
            responses: {
                200: {
                    schema: V1RotateSecretsResponseSchema,
                    description: 'Secrets rotated',
                },
                400: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event) => handleSecretsRotate(event),
    },
});
