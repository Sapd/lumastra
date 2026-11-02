// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/webhooks/[id]/test.ts — POST /webhooks/{id}/test
 *
 * Sends a synthetic CloudEvent to the hook URL to verify delivery.
 * Auth: scope(webhooks:write).
 * Returns: { delivered, status?, error?, durationMs } — not a standard resource;
 * the delivery outcome IS the response. Errors from SSRF guard and scope use
 * problem+json; delivery failures use bare JSON (Class R: the response IS the result).
 */

import { json } from '@sveltejs/kit';
import { webhookDeliveryError } from '$lib/server/tasks/webhook-delivery-status.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { decrypt, deriveMasterKey } from '$lib/server/tasks/secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { signatureHeader, sanitizeWebhookHeaders } from '$lib/server/tasks/webhook-signature.js';
import { operatorWebhookSecretContext } from '$lib/server/tasks/webhook-outbox.js';
import { config } from '$lib/server/config.js';
import { assertWebhookTargetUrl, safeFetch, UrlSafetyError } from '$lib/server/tasks/url-safety.js';
import { scrubConnectionText } from '$lib/server/utils/fetch-error-cause.js';
import crypto from 'node:crypto';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { z } from 'zod';

const WebhookTestResultSchema = z.object({
    delivered: z.boolean(),
    status: z.number().int().optional().meta({ description: "The target URL's response status" }),
    error: z.string().optional().meta({ description: 'Delivery failure reason' }),
    durationMs: z.number().meta({ description: 'Round-trip time to the target URL' }),
});

interface HookRow {
    id: string;
    url: string;
    secret_encrypted: Buffer;
    headers: unknown;
}

function asStringRecord(value: unknown): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = String(v ?? '');
    }
    return out;
}

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Webhooks'],
            summary: 'Test a webhook',
            stability: 'beta',
            description:
                'Sends a test payload to the configured webhook endpoint. Requires `webhooks:write`. ' +
                'The delivery outcome IS the response — a non-2xx target response or a network error ' +
                'both resolve with `delivered: false`, not an error status.',
            responses: {
                200: {
                    schema: WebhookTestResultSchema,
                    description: 'Delivery attempted (see `delivered`)',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Webhook not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['webhooks:write'] },
    // POST /webhooks/{id}/test carries no request body — no request schema needed.
    handlers: {
        /**
         * POST /webhooks/{id}/test
         *
         * Sends a synthetic CloudEvent to the hook's URL and returns the result.
         * This is a Class R-adjacent endpoint — the "resource" is the delivery result,
         * not a stored entity. Auth/not-found errors use problem+json; delivery
         * outcome is bare JSON (the result itself is the response).
         */
        POST: async (event, _ctx) => {
            const id = event.params.id!;

            if (!UUID_RE.test(id)) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            const rows = await sql<HookRow[]>`
				SELECT id, url, secret_encrypted, headers
				FROM task_webhook_hooks
				WHERE id = ${id}::uuid
			`;

            if (rows.length === 0) {
                return ApiProblem.notFound(`Webhook '${id}'`);
            }

            const hook = rows[0];

            // SSRF guard — reject private/loopback/non-http(s) targets, except
            // hosts on the operator's private-host allowlist.
            let registeredUrl: URL;
            try {
                registeredUrl = assertWebhookTargetUrl(
                    hook.url,
                    config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
                );
            } catch (err) {
                if (err instanceof UrlSafetyError) {
                    // Delivery-result shape: the SSRF rejection IS the outcome.
                    return json(
                        {
                            delivered: false,
                            error: `URL rejected by SSRF guard: ${scrubConnectionText(err.message)}`,
                        },
                        { status: 400 },
                    );
                }
                return ApiProblem.internalError('URL validation failed');
            }

            let secret: string;
            try {
                const masterKey = deriveMasterKey(resolveMasterKey());
                secret = decrypt(
                    hook.secret_encrypted,
                    masterKey,
                    operatorWebhookSecretContext(hook.id),
                );
            } catch (err) {
                return ApiProblem.dependencyUnavailable(
                    `Failed to decrypt webhook secret: ${err instanceof Error ? err.message : String(err)}`,
                );
            }

            // Build a synthetic CloudEvent.
            const eventId = crypto.randomUUID();
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            const payload = {
                specversion: '1.0',
                type: 'org.lumastra.task.run.completed',
                source: '/lumastra/admin/webhook-test',
                id: eventId,
                time: new Date().toISOString(),
                datacontenttype: 'application/json',
                subject: 'test/test',
                data: {
                    synthetic: true,
                    triggeredBy: userId,
                },
            };

            const timestamp = Math.floor(Date.now() / 1000);
            const body = JSON.stringify(payload);
            const customHeaders = asStringRecord(hook.headers) ?? {};
            const start = Date.now();

            // 30s timeout — never block the admin UI on a hung endpoint.
            const controller = new AbortController();
            const timeoutHandle = setTimeout(() => controller.abort(), 30_000);

            let response: Response;
            try {
                response = await safeFetch(
                    hook.url,
                    {
                        method: 'POST',
                        signal: controller.signal,
                        // Operator-supplied headers spread FIRST so the X-Lumastra-*
                        // signature/event headers always win.
                        headers: {
                            ...sanitizeWebhookHeaders(customHeaders),
                            'Content-Type': 'application/json',
                            'X-Lumastra-Signature': signatureHeader(timestamp, body, secret),
                            'X-Lumastra-Event': payload.type,
                            'X-Lumastra-Event-Id': eventId,
                        },
                        body,
                    },
                    {
                        allowPrivateHosts: config.WEBHOOK_PRIVATE_HOST_ALLOWLIST,
                        // Same rule as the outbox: the signed test body never
                        // follows a redirect off the registered origin.
                        validateHop: (hopUrl) => {
                            if (hopUrl.origin !== registeredUrl.origin) {
                                throw new UrlSafetyError(
                                    `webhook redirect blocked: hop to cross-origin host ${hopUrl.origin}`,
                                );
                            }
                        },
                    },
                );
            } catch {
                const durationMs = Date.now() - start;
                return json({
                    delivered: false,
                    error: webhookDeliveryError(undefined, 'network failure'),
                    durationMs,
                });
            } finally {
                clearTimeout(timeoutHandle);
            }

            const durationMs = Date.now() - start;

            if (response.ok) {
                return json({ delivered: true, status: response.status, durationMs });
            }

            // Receivers can reflect credentials in their error page. Return a
            // controlled cause for public and private targets alike.
            await response.body?.cancel().catch(() => {});

            return json({
                delivered: false,
                status: response.status,
                error: webhookDeliveryError(response.status, 'delivery failure'),
                durationMs,
            });
        },
    },
});
