// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/notifications/broadcasts/[id]/index.ts
 *
 *   PATCH  /api/admin/notifications/broadcasts/{id} — pin or unpin
 *   DELETE /api/admin/notifications/broadcasts/{id} — retract from every inbox
 *
 * Pin state is the only mutable property of a sent broadcast, and deletion is
 * the only retraction — the text itself is immutable, like every other
 * notification kind's. See `admin-broadcasts.ts` (schemas) for that argument.
 *
 * Both handlers call the query module directly rather than through a service:
 * each is a single statement with no transaction, no fan-out and no
 * cross-surface effect, which is the same shape as the other small admin
 * mutations in `defs/admin/**` (library-groups-item, library-paths-item, …).
 * The SEND path is the one with real orchestration, and that one does have a
 * service.
 *
 * Auth: admin. Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    deleteBroadcast,
    setBroadcastPin,
} from '$lib/server/database/queries/admin-broadcasts.queries.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    AdminBroadcastSchema,
    SetBroadcastPinRequestFieldsSchema,
    SetBroadcastPinRequestSchema,
} from '$lib/schemas/admin-broadcasts.js';

/**
 * The def-level body schema, all fields optional — and the strict one is
 * re-applied inside PATCH.
 *
 * `request.body` is declared once for the whole def, but the mount
 * body-validates every method that MAY carry one, DELETE included, decoding an
 * absent body to `{}`. A required `pinned` would therefore 422 every bodyless
 * DELETE. The codebase's existing PATCH+DELETE defs solve this the same way
 * (`libraryGroupPatchBodySchema` in `defs/admin/library-groups-item.ts` is
 * all-optional for exactly this reason).
 *
 * What that pattern loses — the mount no longer rejects a `pinned`-less PATCH,
 * nor an already-past `pinExpiresAt` — is bought back below by re-parsing with
 * the strict schema in the handler and answering the same 422 the mount would
 * have. So both requirements are still enforced; they are enforced one layer in.
 *
 * Built from the un-refined FIELDS schema rather than from the contract schema
 * because Zod refuses `.partial()` on a schema that carries refinements — a
 * cross-field rule written against the whole object has no meaning against a
 * subset of it. That is the same reasoning as the re-parse, stated by the type
 * system instead of by a comment.
 */
const PinBodySchema = SetBroadcastPinRequestFieldsSchema.partial();

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        // `uuid()` rather than `min(1)`, same reason as the user-facing
        // notification routes: the handler interpolates this into a `::uuid`
        // cast and Postgres THROWS on a malformed one, which the mount turns
        // into a 500 for what is really the caller's bad input.
        params: z.object({ id: z.string().uuid() }),
        body: PinBodySchema,
    },
    handlers: {
        /**
         * Pin or unpin. ONE write regardless of recipient count — pin state
         * lives on the parent row precisely so this does not become a
         * thousand-row UPDATE with a torn state while it runs.
         *
         * Nothing is pushed to clients on a pin change and nothing needs to be:
         * a pin is only ever observed through a fetch of the inbox, which
         * evaluates the pin predicate live, so the next `loadInitial()` or focus
         * reconcile is already correct. Adding a wire kind for it would widen a
         * public contract permanently to save a few seconds of staleness on a
         * change measured in days.
         */
        PATCH: async (event, ctx) => {
            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const id = event.params.id;
            if (!id) return ApiProblem.notFound('Broadcast not found');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Re-apply the STRICT schema the def could not declare (see
            // PinBodySchema above) so a `pinned`-less PATCH gets the 422 it
            // deserves rather than being read as an unpin.
            const parsed = SetBroadcastPinRequestSchema.safeParse(ctx.input!.body ?? {});
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((issue) => ({
                        field: issue.path.join('.') || 'body',
                        message: issue.message,
                    })),
                );
            }
            const input = parsed.data;

            const updated = await setBroadcastPin(sql, id, {
                pinned: input.pinned,
                ...(input.pinExpiresAt ? { pinExpiresAt: input.pinExpiresAt } : {}),
                pinnedBy: username,
            });
            if (!updated) return ApiProblem.notFound('Broadcast not found');

            auditLog(
                input.pinned ? 'notification.broadcast.pin' : 'notification.broadcast.unpin',
                id,
                auditActor(event),
                { pinExpiresAt: updated.pinExpiresAt },
            );

            return json(AdminBroadcastSchema.parse(updated));
        },

        /**
         * Delete the announcement, and with it every recipient's copy.
         *
         * The cascade (`user_notifications.broadcast_id ON DELETE CASCADE`) is
         * the feature, not a side effect: since the text is immutable, pulling
         * the parent is the only way to retract something sent by mistake.
         */
        DELETE: async (event, _ctx) => {
            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const id = event.params.id;
            if (!id) return ApiProblem.notFound('Broadcast not found');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const removed = await deleteBroadcast(sql, id);
            if (!removed) return ApiProblem.notFound('Broadcast not found');

            auditLog('notification.broadcast.delete', id, auditActor(event));

            return new Response(null, { status: 204 });
        },
    },
});
