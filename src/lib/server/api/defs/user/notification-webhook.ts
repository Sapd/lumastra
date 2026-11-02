// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/notification-webhook.ts
 *   GET    /me/notification-webhook  — read the caller's own endpoint
 *   POST   /me/notification-webhook  — set/replace it (returns the secret ONCE)
 *   DELETE /me/notification-webhook  — clear it
 *
 * Auth: `{kind:'user'}` — self-scoped on every method. There is no user id in
 * the path and no cross-user read in the query module, so "never expose one
 * user's hook URL to another user" is a property of the shape rather than of a
 * `WHERE` clause someone has to remember. The admin surfaces (`GET /webhooks`,
 * the outbox view) read `task_webhook_hooks` / `task_webhook_outbox` and cannot
 * reach this table at all.
 *
 * ## The SSRF guard runs here as well as at delivery
 *
 * `assertPublicHttpUrl` is the SAME guard `WebhookOutbox.deliver()` applies
 * (`tasks/url-safety.ts`), and the same one the admin `POST /webhooks` handler
 * already applies at store time — this is deliberately not a second
 * implementation. Applying it at save is not redundancy: without it, pasting
 * `http://192.168.1.5/hook` succeeds, and the user's first hint of a problem is
 * a dead outbox row they cannot see, on an admin screen they cannot open. With
 * it they get a 422 naming the reason while the field is still in front of them.
 *
 * It is a SYNTACTIC gate — scheme, userinfo, `.local`, and private/loopback/
 * CGNAT/metadata IP literals. A hostname that RESOLVES to a private address is
 * caught at delivery instead, by `safeFetch`'s DNS resolution + connection
 * pinning. That split is inherited from the admin path and is the right one for
 * a save handler: a DNS lookup on a user-supplied hostname is itself an outbound
 * request driven by unvalidated input, and it can answer differently a second
 * later anyway.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { encrypt, deriveMasterKey } from '$lib/server/tasks/secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { assertPublicHttpUrl } from '$lib/server/tasks/url-safety.js';
import { userWebhookSecretContext } from '$lib/server/tasks/webhook-outbox.js';
import { UserNotificationWebhookSchema } from '$lib/schemas/api-user-responses.js';
import {
    getUserNotificationWebhook,
    upsertUserNotificationWebhook,
    deleteUserNotificationWebhook,
} from '$lib/server/database/queries/user-notification-webhooks.queries.js';

/**
 * `url` is `.optional()` at the SCHEMA level and required by the POST handler.
 *
 * `request.body` is declared once per def, not per method, and `mount()`
 * body-validates every method that may carry one — POST, PUT, PATCH **and
 * DELETE** (`methodCanHaveBody`). An empty DELETE body decodes to `{}`, so a
 * required `url` here would make `DELETE /me/notification-webhook` fail
 * validation with a 422 before its handler ever ran: a user could set an
 * endpoint and never remove it. The min/max bounds still apply whenever the
 * field IS present, and POST's own presence check is two lines below.
 */
const NotificationWebhookBody = z.object({
    url: z.string().min(1).max(2048).optional(),
});

/** 32 bytes of hex — the same shape the admin UI suggests for an operator hook. */
function generateSecret(): string {
    return randomBytes(32).toString('hex');
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: "Get the caller's notification webhook",
            stability: 'beta',
            auth: 'bearer',
            description:
                "Returns the authenticated user's own outbound notification endpoint. " +
                'Self-scoped — there is no path parameter and no way to read another ' +
                "user's endpoint. `enabled` reports whether the operator has switched the " +
                'feature on at all, and is returned even when it is off: a client must be ' +
                'able to distinguish "the administrator has not enabled this" from "you ' +
                'have not configured it", and a saved endpoint that is dormant because the ' +
                'operator flipped the switch should be shown as such rather than as absent. ' +
                'The signing secret is never returned by this method.',
            responses: {
                200: {
                    schema: UserNotificationWebhookSchema,
                    description: 'The caller’s webhook, or `configured: false`',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
        POST: {
            tags: ['User'],
            summary: "Set or replace the caller's notification webhook",
            body: NotificationWebhookBody.required(),
            bodyRequired: true,
            stability: 'beta',
            auth: 'bearer',
            description:
                'Stores the endpoint and returns a freshly generated HMAC signing secret ' +
                '**exactly once** — the secret is stored encrypted and no later read can ' +
                'produce it, so a client that does not persist it must POST again to get a ' +
                'new one. Deliveries are signed with it, matching operator webhooks.\n\n' +
                'The URL is checked by the same SSRF guard that runs at delivery time: ' +
                'non-http(s) schemes, embedded userinfo, `.local` hosts and private / ' +
                'loopback / CGNAT / cloud-metadata IP literals are rejected with 422 while ' +
                'the field is still in front of the user, rather than failing later as a ' +
                'dead outbox row they cannot see. The guard is syntactic; a hostname that ' +
                'RESOLVES to a private address is caught at delivery instead.\n\n' +
                'Returns 404 when the administrator has not enabled the feature — a ' +
                'disabled server must not accumulate endpoints that would start firing the ' +
                'moment the switch is flipped on.',
            responses: {
                200: {
                    schema: UserNotificationWebhookSchema,
                    description: 'Stored. `secret` is present on this response only.',
                },
                401: 'Authentication required',
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                404: 'Per-user notification webhooks are not enabled on this server',
                422: 'Missing `url`, or the URL was rejected by the SSRF guard',
                503: 'Database unavailable, or the secret could not be encrypted',
            },
        },
        DELETE: {
            tags: ['User'],
            summary: "Clear the caller's notification webhook",
            stability: 'beta',
            auth: 'bearer',
            description:
                "Removes the caller's endpoint and any queued deliveries for it (the " +
                'outbox rows cascade). Deliberately allowed even while the feature is ' +
                'disabled: a user must be able to withdraw their endpoint regardless of ' +
                'what the operator has since switched off. Idempotent — clearing when ' +
                'nothing is configured succeeds.',
            responses: {
                200: {
                    schema: UserNotificationWebhookSchema,
                    description: 'Cleared — `configured: false`',
                },
                401: 'Authentication required',
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: NotificationWebhookBody,
        bodyMethods: ['POST'],
    },
    handlers: {
        /**
         * GET /me/notification-webhook
         *
         * `enabled` is reported even when the feature is off, and the read is
         * NOT 404'd in that case: the settings UI needs to distinguish "the
         * operator has not enabled this" from "you have not configured it", and
         * a user whose saved URL is dormant because the operator flipped the
         * switch should be told that rather than shown an empty field.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const enabled = config.FEATURE_USER_NOTIFICATION_WEBHOOKS;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const row = await getUserNotificationWebhook(sql, userId);
            if (!row) return json({ configured: false, enabled });

            return json({
                configured: true,
                enabled,
                url: row.url,
                updatedAt: row.updated_at.toISOString(),
            });
        },

        /**
         * POST /me/notification-webhook
         *
         * Sets or replaces the endpoint. Returns the freshly generated signing
         * secret exactly once — it is stored encrypted and no later read can
         * produce it.
         */
        POST: async (event, ctx) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            // Write path is hard-gated. A disabled feature must not accumulate
            // endpoints that start firing the moment an operator flips it on.
            if (!config.FEATURE_USER_NOTIFICATION_WEBHOOKS) {
                return ApiProblem.notFound(
                    'Per-user notification webhooks are not enabled on this server',
                );
            }

            const body = ctx.input?.body as { url?: string } | undefined;
            if (!body?.url) {
                return ApiProblem.validationFailed([
                    { field: 'body.url', message: 'Required string field' },
                ]);
            }

            // Same guard, same module, same rejection vocabulary as the admin
            // hook and as delivery. See the file header for why it runs here too.
            try {
                assertPublicHttpUrl(body.url);
            } catch (err) {
                return ApiProblem.validationFailed([
                    {
                        field: 'body.url',
                        message: `URL rejected: ${err instanceof Error ? err.message : String(err)}`,
                    },
                ]);
            }

            const secret = generateSecret();
            let secretEncrypted: Buffer;
            try {
                // Bound to the owning user (security review 2026-09-13, C19):
                // one row per user, so the user id is the identity that is both
                // stable for the row's life and known before the upsert runs.
                secretEncrypted = encrypt(
                    secret,
                    deriveMasterKey(resolveMasterKey()),
                    userWebhookSecretContext(userId),
                );
            } catch (err) {
                return ApiProblem.dependencyUnavailable(
                    `Failed to encrypt webhook secret: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const row = await upsertUserNotificationWebhook(sql, {
                userId,
                url: body.url,
                secretEncrypted,
            });

            return json({
                configured: true,
                enabled: true,
                url: row.url,
                updatedAt: row.updated_at.toISOString(),
                secret,
            });
        },

        /**
         * DELETE /me/notification-webhook
         *
         * Always allowed, including while the feature is disabled — a user must
         * be able to withdraw their endpoint regardless of what the operator has
         * since switched off.
         */
        DELETE: async (event, _ctx) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            await deleteUserNotificationWebhook(sql, userId);
            return json({
                configured: false,
                enabled: config.FEATURE_USER_NOTIFICATION_WEBHOOKS,
            });
        },
    },
});
