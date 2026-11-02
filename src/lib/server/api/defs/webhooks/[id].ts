// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/webhooks/[id].ts — PUT /webhooks/{id} + DELETE /webhooks/{id}
 *
 * - PUT returns the full resource + Location header.
 * - DELETE returns 204 no-content.
 * - All errors route through problem+json.
 *
 * Auth: scope(webhooks:write) for all methods.
 */

import { json } from '@sveltejs/kit';
import { WEBHOOK_DELIVERY_DESCRIPTION } from './_delivery.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { encrypt, deriveMasterKey } from '$lib/server/tasks/secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { WebhookUpdateSchema } from '$lib/schemas/api-v1.js';
import { config } from '$lib/server/config.js';
import { assertWebhookTargetUrl } from '$lib/server/tasks/url-safety.js';
import { publishMessage } from '$lib/server/cache/valkey.js';
import {
    WEBHOOK_HOOKS_INVALIDATE_CHANNEL,
    operatorWebhookSecretContext,
} from '$lib/server/tasks/webhook-outbox.js';
import {
    updateWebhookHookWithSecret,
    updateWebhookHookWithoutSecret,
    deleteWebhookHook,
    getWebhookHookById,
} from '$lib/server/database/queries/webhook.queries.js';
import { rowToWebhook } from './index.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { WebhookRowSchema } from '$lib/schemas/api-v1';
import { apiUrl } from '$lib/shared/api-urls.js';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * Body contract for this def (applies to PUT *and* DELETE, since mount()
 * validates the body of every body-capable method including DELETE).
 *
 * Must be a lenient superset: DELETE carries NO body (decoded to `{}` by
 * mount), so every field has to be optional here or a valid DELETE would be
 * rejected with 422. The strict PUT contract (url + eventFilter required) is
 * still enforced by the handler, which re-validates the already-parsed
 * ctx.input.body object against WebhookUpdateSchema — no stream re-read, so the
 * double-read regression is avoided while behavior/ordering are unchanged.
 */
const WebhookUpdateBody = WebhookUpdateSchema.partial();

export const def = defineEndpoint({
    docs: {
        PUT: {
            tags: ['Webhooks'],
            summary: 'Update a webhook',
            stability: 'beta',
            description:
                'Updates an existing webhook subscription. Requires `webhooks:write`. ' +
                WEBHOOK_DELIVERY_DESCRIPTION,
            body: WebhookUpdateSchema,
            responses: {
                200: {
                    schema: WebhookRowSchema,
                    description: 'Webhook updated (full resource; secret write-only)',
                },
                422: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Webhook not found',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Webhooks'],
            summary: 'Delete a webhook',
            stability: 'beta',
            description: 'Deletes a webhook subscription by id. Requires `webhooks:write`.',
            responses: {
                204: 'Webhook deleted (no content)',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Webhook not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['webhooks:write'] },
    request: {
        body: WebhookUpdateBody,
        bodyMethods: ['PUT'],
    },
    handlers: {
        /**
         * PUT /webhooks/{id}
         *
         * Update a webhook hook. Accepts partial body (secret is optional).
         * Returns 200 + full resource + Location header (was 200 { id } only).
         * SSRF guard applied if url is updated.
         */
        PUT: async (event, ctx) => {
            const id = event.params.id!;

            if (!UUID_RE.test(id)) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            // Source the raw body from mount()'s pre-parsed ctx.input.body when
            // available (the request stream is consumed by then); otherwise read
            // the stream for direct handler calls (unit tests / non-mount wiring).
            // Either way, validate against the strict WebhookUpdateSchema so the
            // PUT contract (url + eventFilter required) is enforced.
            let rawBody: unknown;
            if (ctx.input?.body !== undefined) {
                rawBody = ctx.input.body;
            } else {
                try {
                    rawBody = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }
            }

            const parsed = WebhookUpdateSchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const parsedData = parsed.data;

            const {
                url,
                secret,
                eventFilter,
                taskFilter,
                libraryGroupIds,
                headers,
                active,
                includeProgress,
                mediaTypeFilter,
                batchWindowSeconds,
                maxBatchSize,
                label,
            } = parsedData;
            // Omitted keeps the stored label; null or "" clears it.
            const labelUpdate = label === undefined ? undefined : label ? label : null;

            // SSRF guard when URL is being updated.
            if (url) {
                try {
                    assertWebhookTargetUrl(url, config.WEBHOOK_PRIVATE_HOST_ALLOWLIST);
                } catch (err) {
                    return ApiProblem.validationFailed(
                        `Webhook URL rejected: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            let updatedId: string | null;
            if (secret !== undefined) {
                let secretEncrypted: Buffer;
                try {
                    const masterKey = deriveMasterKey(resolveMasterKey());
                    // Bound to this hook id (security review 2026-09-13, C19).
                    secretEncrypted = encrypt(secret, masterKey, operatorWebhookSecretContext(id));
                } catch (err) {
                    return ApiProblem.dependencyUnavailable(
                        `Failed to encrypt webhook secret: ${err instanceof Error ? err.message : String(err)}`,
                    );
                }

                updatedId = await updateWebhookHookWithSecret(sql, {
                    id,
                    url,
                    secretEncrypted,
                    eventFilter,
                    taskFilter: taskFilter ?? null,
                    libraryGroupFilter: libraryGroupIds ?? null,
                    headers: headers ?? null,
                    active: active ?? true,
                    includeProgress: includeProgress ?? false,
                    mediaTypeFilter: mediaTypeFilter ?? null,
                    batchWindowSeconds: batchWindowSeconds ?? null,
                    maxBatchSize: maxBatchSize ?? null,
                    label: labelUpdate,
                });
            } else {
                updatedId = await updateWebhookHookWithoutSecret(sql, {
                    id,
                    url,
                    eventFilter,
                    taskFilter: taskFilter ?? null,
                    libraryGroupFilter: libraryGroupIds ?? null,
                    headers: headers ?? null,
                    active: active ?? true,
                    includeProgress: includeProgress ?? false,
                    mediaTypeFilter: mediaTypeFilter ?? null,
                    batchWindowSeconds: batchWindowSeconds ?? null,
                    maxBatchSize: maxBatchSize ?? null,
                    label: labelUpdate,
                });
            }

            if (!updatedId) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            void publishMessage(WEBHOOK_HOOKS_INVALIDATE_CHANNEL, '1');

            // Return full resource + Location header.
            const row = await getWebhookHookById(sql, updatedId);
            if (!row) {
                return ApiProblem.internalError('Webhook updated but could not be retrieved');
            }

            return json(rowToWebhook(row), {
                status: 200,
                headers: { Location: apiUrl(ctx.surface, `/webhooks/${updatedId}`) },
            });
        },

        /**
         * DELETE /webhooks/{id}
         *
         * Delete a webhook hook.
         * Returns 204 no-content.
         */
        DELETE: async (event, _ctx) => {
            const id = event.params.id!;

            // Reject malformed UUIDs so the `${id}::uuid` cast doesn't bubble a 500.
            if (!UUID_RE.test(id)) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            // ON DELETE CASCADE on task_webhook_outbox handles outbox cleanup.
            const deletedId = await deleteWebhookHook(sql, id);

            if (!deletedId) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            // Tell every replica's WebhookOutbox to drop its in-memory hook cache.
            void publishMessage(WEBHOOK_HOOKS_INVALIDATE_CHANNEL, '1');

            // 204 no-content.
            return new Response(null, { status: 204 });
        },
    },
});
