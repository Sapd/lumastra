// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Inbound webhook dispatch → `IntegrationDefinition.handleWebhook`.
 *
 * `handleWebhook` shipped as a declared contract with no route behind it. This
 * is that route's logic, kept out of `+server.ts` so it is testable without a
 * SvelteKit request lifecycle.
 *
 * AUTHENTICATION. This endpoint is deliberately session-less: the senders are
 * external systems (an *arr app, a chat platform, a CI job) that hold no cookie
 * and no bearer token. Authentication is a per-integration shared secret, read
 * from the integration's own `plugin_secrets` scope under the key
 * `webhookSecret`, presented as `X-Plugin-Webhook-Secret` and compared in
 * constant time.
 *
 * Two gates must BOTH be open: the integration declares
 * `capabilities.webhook: true` (the author opting in) and the operator has set
 * the secret (the deployment opting in). Either one missing answers 404 —
 * never 401 — so an unauthenticated caller cannot enumerate which integrations
 * exist or which are merely waiting to be configured.
 *
 * A WRONG secret answers 404 too, for the same reason: 401-vs-404 would tell an
 * attacker exactly which integrations are configured and have a secret set,
 * which is the enumeration the paragraph above rules out. Failed attempts are
 * rate limited per IP — this is a shared secret on a session-less endpoint, and
 * it was the one credential surface in the plugin system with no limiter, so
 * only the operator's choice of secret stood between it and unlimited guessing.
 * A correct secret never spends budget, so a busy legitimate sender cannot lock
 * itself out.
 */

import crypto from 'node:crypto';
import type { IntegrationDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('IntegrationWebhook');

/** Header carrying the shared secret. */
export const WEBHOOK_SECRET_HEADER = 'x-plugin-webhook-secret';

/** Secret key, in the integration's own `plugin_secrets` scope. */
export const WEBHOOK_SECRET_KEY = 'webhookSecret';

/** Cap on the body we will buffer before handing it to a plugin. */
const MAX_BODY_BYTES = 1_000_000;

export interface WebhookDispatchInput {
    integrationId: string;
    request: Request;
    /** Strict (non-spoofable) peer address — the rate-limit bucket key. */
    clientIp: string;
}

export interface WebhookDispatchDeps {
    getIntegration(id: string): IntegrationDefinition | undefined;
    buildCtx(integrationId: string): PluginContext;
    readSecret(integrationId: string): Promise<string | null>;
    /** Consumes one failed-attempt slot. Injected so tests need no Valkey. */
    checkRate(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean }>;
    /** Reads the budget WITHOUT consuming, so a peek cannot lock anyone out. */
    peekRate(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean }>;
}

/** Failed secret presentations per IP per window. */
export const WEBHOOK_FAIL_LIMIT = 20;
export const WEBHOOK_FAIL_WINDOW = 15 * 60;

const defaultDeps: WebhookDispatchDeps = {
    checkRate: async (key, limit, windowSeconds) => {
        // Lazy: this module is imported by the outbox, and a static import of
        // the rate limiter pulls Valkey into that module graph.
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        return checkRateLimit(key, limit, windowSeconds);
    },
    peekRate: async (key, limit, windowSeconds) => {
        const { peekRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        return peekRateLimit(key, limit, windowSeconds);
    },
    getIntegration: (id) => taskRegistry.getIntegration(id),
    buildCtx: (id) => buildPluginContext(id),
    readSecret: async (id) => {
        try {
            return await buildPluginContext(id).secrets.getOptional(WEBHOOK_SECRET_KEY);
        } catch (err) {
            logger.warn('failed to read webhook secret', {
                integration: id,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    },
};

function notFound(): Response {
    return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
    });
}

/** Constant-time equality that does not leak length through an early return. */
function secretMatches(presented: string | null, expected: string): boolean {
    if (presented === null) return false;
    const a = Buffer.from(presented, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual REQUIRES equal lengths, so hash both first: the digests
    // are always 32 bytes and a length difference stops being a fast path.
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Handle one inbound webhook. Always resolves to a Response; never throws.
 */
export async function dispatchIntegrationWebhook(
    input: WebhookDispatchInput,
    deps: WebhookDispatchDeps = defaultDeps,
): Promise<Response> {
    /**
     * Every rejection leaves by this door: it spends one failure slot and
     * answers the SAME 404, whatever the actual reason.
     *
     * The status must not vary with the budget. Consulting the limiter only
     * after the secret comparison, and answering 429 once exhausted, re-created
     * precisely the oracle the 404-everywhere rule exists to close: a
     * configured integration answered 404 x20 then 429, while a nonexistent id
     * answered 404 forever. That difference reliably identifies which
     * integration ids are real AND have a secret configured — to an
     * unauthenticated caller.
     *
     * Spending the slot on unknown ids too is the other half. Otherwise
     * id-enumeration is free and unbounded while secret-guessing is capped,
     * which meters the expensive attack and leaves the cheap one open.
     */
    const reject = async (reason: string, integration?: string): Promise<Response> => {
        logger.warn(`webhook rejected: ${reason}`, integration ? { integration } : {});
        await deps.checkRate(rateKey, WEBHOOK_FAIL_LIMIT, WEBHOOK_FAIL_WINDOW);
        return notFound();
    };

    // Budget exhausted ⇒ refuse before doing ANY work: no registry lookup, no
    // secret read, no comparison. This is what actually bounds brute force —
    // the failure counter alone only records that it happened. A PEEK, not a
    // consume, so checking cannot itself extend a lockout.
    const rateKey = `plugin-webhook:fail:${input.clientIp}`;
    const budget = await deps.peekRate(rateKey, WEBHOOK_FAIL_LIMIT, WEBHOOK_FAIL_WINDOW);
    if (!budget.allowed) return notFound();

    const def = deps.getIntegration(input.integrationId);
    // Author opt-in and a usable handler. Both are "does not exist" from the
    // caller's point of view.
    if (!def || def.capabilities?.webhook !== true) return reject('unknown or not webhook-capable');
    if (typeof def.handleWebhook !== 'function') return reject('no handleWebhook', def.id);

    // Operator opt-in.
    const expected = await deps.readSecret(def.id);
    if (!expected) return reject('no secret configured', def.id);

    const presented = input.request.headers.get(WEBHOOK_SECRET_HEADER);
    if (!secretMatches(presented, expected)) {
        return reject('bad secret', def.id);
    }

    let payload: unknown;
    try {
        // C17: `isDeclaredContentLengthOverCap` rejects an honest oversized
        // declared Content-Length without touching the body stream, and
        // `readBoundedBodyText` then bounds a missing/lying Content-Length
        // the same way by aborting the streamed read once the accumulated
        // byte count passes the cap — replacing the previous `.text()` call,
        // which buffered the WHOLE body before the length was ever checked
        // (self-documented at the top of this function's old comment).
        if (isDeclaredContentLengthOverCap(input.request, MAX_BODY_BYTES)) {
            return new Response(JSON.stringify({ error: 'payload too large' }), {
                status: 413,
                headers: { 'content-type': 'application/json' },
            });
        }
        const raw = await readBoundedBodyText(input.request, MAX_BODY_BYTES);
        if (raw === BODY_TOO_LARGE) {
            return new Response(JSON.stringify({ error: 'payload too large' }), {
                status: 413,
                headers: { 'content-type': 'application/json' },
            });
        }
        // A plugin should not have to re-parse the common case, but plenty of
        // senders post form-encoded or plain-text bodies — those arrive intact
        // as a string rather than being rejected.
        try {
            payload = raw.length > 0 ? JSON.parse(raw) : null;
        } catch {
            payload = raw;
        }
    } catch (err) {
        logger.warn('webhook body read failed', {
            integration: def.id,
            error: err instanceof Error ? err.message : String(err),
        });
        return new Response(JSON.stringify({ error: 'could not read request body' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        });
    }

    try {
        const result = await def.handleWebhook(deps.buildCtx(def.id), payload);
        if (result === undefined || result === null) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    } catch (err) {
        // The message may carry plugin internals (a connection string, an
        // upstream token). Log it; answer with nothing.
        logger.error('webhook handler threw', err as Error, { integration: def.id });
        return new Response(JSON.stringify({ error: 'webhook handler failed' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
        });
    }
}
