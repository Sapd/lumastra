// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/webhooks/index.ts — GET /webhooks + POST /webhooks
 *
 * GET /webhooks
 *   Auth: scope(webhooks:write).
 *   Response: { items, page }
 *   Errors: problem+json.
 *
 * POST /webhooks
 *   Auth: scope(webhooks:write).
 *   Returns 201 + resource + Location header.
 *   Keeps write-only secret + SSRF guard verbatim.
 *   Errors: problem+json.
 */

import { webhookDeliveryError } from '$lib/server/tasks/webhook-delivery-status.js';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { WEBHOOK_DELIVERY_DESCRIPTION } from './_delivery.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { encrypt, deriveMasterKey } from '$lib/server/tasks/secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { WebhookCreateSchema } from '$lib/schemas/api-v1.js';
import { config } from '$lib/server/config.js';
import { assertWebhookTargetUrl } from '$lib/server/tasks/url-safety.js';
import { publishMessage } from '$lib/server/cache/valkey.js';
import {
    WEBHOOK_HOOKS_INVALIDATE_CHANNEL,
    operatorWebhookSecretContext,
} from '$lib/server/tasks/webhook-outbox.js';
import {
    listWebhookHooks,
    insertWebhookHook,
    getWebhookHookById,
    type WebhookHookRow,
} from '$lib/server/database/queries/webhook.queries.js';
import { WebhooksListResponseSchema, WebhookRowSchema } from '$lib/schemas/api-v1';
import { apiUrl } from '$lib/shared/api-urls.js';

// ---------------------------------------------------------------------------
// Request schema — POST /webhooks body
// ---------------------------------------------------------------------------

/**
 * POST /webhooks body contract.
 *
 * Use WebhookCreateSchema verbatim — the SAME schema the handler validates
 * against. This makes the input contract the single source of truth: mount()
 * parses the body once (defaults + min/max + URL refine applied) and exposes
 * it on `ctx.input.body`. The handler reads that pre-parsed value instead of
 * re-reading the (now-consumed) request stream, which was the regression that
 * made a valid POST return 422 ("body already read"). Status/ordering are
 * unchanged: bad input still fails validation with the same 422 it did before.
 */
const WebhookCreateBody = WebhookCreateSchema;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    return [];
}

function asStringRecord(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = String(v ?? '');
    }
    return out;
}

/** Serialize a DB row to the public webhook shape (secret never returned). */
export function rowToWebhook(r: WebhookHookRow) {
    return {
        id: r.id,
        url: r.url,
        eventFilter: asStringArray(r.event_filter),
        taskFilter: r.task_filter ? asStringArray(r.task_filter) : undefined,
        libraryGroupIds: r.library_group_filter ? asStringArray(r.library_group_filter) : undefined,
        mediaTypeFilter: r.media_type_filter ? asStringArray(r.media_type_filter) : undefined,
        headers: asStringRecord(r.headers) ?? undefined,
        active: r.active,
        lastStatus: r.last_status ?? undefined,
        lastError: webhookDeliveryError(r.last_status, r.last_error),
        lastDeliveredAt: r.last_delivered_at ?? undefined,
        deadCount: r.dead_count ?? 0,
        includeProgress: r.include_progress,
        batchWindowSeconds: r.batch_window_seconds,
        maxBatchSize: r.max_batch_size,
        label: r.label ?? undefined,
        hasSecret: Buffer.isBuffer(r.secret_encrypted) && r.secret_encrypted.length > 0,
        createdBy: r.created_by,
        createdAt: r.created_at,
    };
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Webhooks'],
            summary: 'List webhooks',
            stability: 'beta',
            description:
                'Returns all configured outbound webhooks (secrets masked). Requires `webhooks:write`.',
            responses: {
                200: {
                    schema: WebhooksListResponseSchema,
                    description: 'Webhooks list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Webhooks'],
            summary: 'Create a webhook',
            stability: 'beta',
            description:
                'Creates a new outbound webhook subscription. Requires `webhooks:write`. ' +
                WEBHOOK_DELIVERY_DESCRIPTION,
            body: WebhookCreateSchema,
            responses: {
                201: {
                    schema: WebhookRowSchema,
                    description: 'Webhook created (full resource; secret write-only)',
                },
                422: 'Validation error',
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['webhooks:write'] },
    request: {
        // body applies to POST; GET has no body (mount() skips body on GET).
        body: WebhookCreateBody,
    },
    handlers: {
        /**
         * GET /webhooks
         *
         * Returns all webhook hooks.
         * Response: { items, page } — collection envelope.
         */
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            let rows: WebhookHookRow[];
            try {
                rows = await listWebhookHooks(sql);
            } catch {
                return ApiProblem.dependencyUnavailable(
                    'Database unavailable while fetching webhooks',
                );
            }
            const items = rows.map(rowToWebhook);

            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },

        /**
         * POST /webhooks
         *
         * Create a new webhook hook.
         * Returns 201 + resource body + Location header.
         * Keeps the write-only secret (shown once via hasSecret; never returned in GET).
         * SSRF guard applied at store time.
         */
        POST: async (event, ctx) => {
            // When called via mount(), the body was already validated by
            // validateRequest and is available on ctx.input.body (the request
            // stream is consumed). When the handler is called directly (unit
            // tests / legacy wiring without mount()), fall back to re-parsing
            // the body from the stream with the same schema.
            let parsedData: z.infer<typeof WebhookCreateSchema>;
            if (ctx.input?.body) {
                parsedData = ctx.input.body as z.infer<typeof WebhookCreateSchema>;
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }

                const parsed = WebhookCreateSchema.safeParse(rawBody);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                parsedData = parsed.data;
            }

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

            // SSRF guard — reject loopback/private/link-local targets at store time.
            try {
                assertWebhookTargetUrl(url, config.WEBHOOK_PRIVATE_HOST_ALLOWLIST);
            } catch (err) {
                return ApiProblem.validationFailed(
                    `Webhook URL rejected: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            // Encrypt the secret before storage, BOUND to the row it will live
            // in (security review 2026-09-13, C19) — hence the client-generated
            // id: the context has to exist before the INSERT, not come back
            // from it.
            const hookId = randomUUID();
            let secretEncrypted: Buffer;
            try {
                const masterKey = deriveMasterKey(resolveMasterKey());
                secretEncrypted = encrypt(secret, masterKey, operatorWebhookSecretContext(hookId));
            } catch (err) {
                return ApiProblem.dependencyUnavailable(
                    `Failed to encrypt webhook secret: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            let id: string;
            try {
                id = await insertWebhookHook(sql, {
                    id: hookId,
                    url,
                    secretEncrypted,
                    eventFilter,
                    taskFilter: taskFilter ?? null,
                    libraryGroupFilter: libraryGroupIds ?? null,
                    headers: headers ?? null,
                    active,
                    includeProgress,
                    createdBy:
                        event.locals.principal?.username ??
                        event.locals.user?.username ??
                        'unknown',
                    mediaTypeFilter: mediaTypeFilter ?? null,
                    batchWindowSeconds: batchWindowSeconds ?? 60,
                    maxBatchSize: maxBatchSize ?? 25,
                    label: label ? label : null,
                });
            } catch {
                return ApiProblem.internalError('Failed to create webhook');
            }

            // Notify replicas to invalidate their hook cache.
            void publishMessage(WEBHOOK_HOOKS_INVALIDATE_CHANNEL, '1');

            // Return the full resource (without the secret — write-only).
            const row = await getWebhookHookById(sql, id);
            if (!row) {
                // Extremely unlikely — just inserted
                return ApiProblem.internalError('Webhook created but could not be retrieved');
            }

            return json(rowToWebhook(row), {
                status: 201,
                headers: { Location: apiUrl(ctx.surface, `/webhooks/${id}`) },
            });
        },
    },
});
