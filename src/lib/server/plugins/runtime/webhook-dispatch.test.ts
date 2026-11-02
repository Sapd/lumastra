// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — inbound webhook dispatch to `IntegrationDefinition.handleWebhook`.
 *
 * This endpoint is reachable WITHOUT a session: the senders are external
 * systems (Sonarr, a chat platform, a CI job) that have no cookie and no
 * bearer token. The per-integration shared secret IS the authentication, so
 * these tests are mostly about what must NOT get through, and about not
 * confirming to an unauthenticated caller which integrations exist.
 */

import { describe, it, expect, vi } from 'vitest';
import type { IntegrationDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { dispatchIntegrationWebhook } from './webhook-dispatch.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const SECRET = 'correct-horse-battery-staple';

const ctxStub = { logger: { warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;

function makeDeps(
    def: IntegrationDefinition | undefined,
    secret: string | null = SECRET,
): NonNullable<Parameters<typeof dispatchIntegrationWebhook>[1]> {
    return {
        getIntegration: () => def,
        buildCtx: () => ctxStub,
        readSecret: async () => secret,
        checkRate: async () => ({ allowed: true }),
        peekRate: async () => ({ allowed: true }),
    };
}

function webhookIntegration(
    handleWebhook?: IntegrationDefinition['handleWebhook'],
    capabilities: IntegrationDefinition['capabilities'] = { webhook: true },
): IntegrationDefinition {
    return { id: 'sonarr-relay', capabilities, handleWebhook } as IntegrationDefinition;
}

function request(body: unknown, secret: string | null = SECRET): Request {
    return new Request('https://host/api/plugin-webhooks/sonarr-relay', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(secret === null ? {} : { 'x-plugin-webhook-secret': secret }),
        },
        body: JSON.stringify(body),
    });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('dispatchIntegrationWebhook', () => {
    it('passes the parsed JSON body to the handler', async () => {
        const handler = vi.fn(async (_ctx: PluginContext, _payload: unknown) => ({ ok: true }));
        const res = await dispatchIntegrationWebhook(
            {
                integrationId: 'sonarr-relay',
                clientIp: '1.2.3.4',
                request: request({ eventType: 'Download' }),
            },
            makeDeps(webhookIntegration(handler)),
        );

        expect(res.status).toBe(200);
        expect(handler.mock.calls[0][1]).toEqual({ eventType: 'Download' });
        expect(await res.json()).toEqual({ ok: true });
    });

    it('answers 204 when the handler returns nothing', async () => {
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(webhookIntegration(async () => undefined)),
        );

        expect(res.status).toBe(204);
    });

    it('passes a non-JSON body through as a raw string', async () => {
        const handler = vi.fn(async (_ctx: PluginContext, _payload: unknown) => undefined);
        const raw = new Request('https://host/api/plugin-webhooks/sonarr-relay', {
            method: 'POST',
            headers: { 'x-plugin-webhook-secret': SECRET },
            body: 'plain text ping',
        });

        await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: raw },
            makeDeps(webhookIntegration(handler)),
        );

        expect(handler.mock.calls[0][1]).toBe('plain text ping');
    });

    it('rejects a wrong secret with 404 — a 401 would confirm the integration is configured', async () => {
        const handler = vi.fn(async () => undefined);
        const res = await dispatchIntegrationWebhook(
            {
                integrationId: 'sonarr-relay',
                clientIp: '1.2.3.4',
                request: request({}, 'wrong-secret'),
            },
            makeDeps(webhookIntegration(handler)),
        );

        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a missing secret header with 404, for the same reason', async () => {
        const handler = vi.fn(async () => undefined);
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, null) },
            makeDeps(webhookIntegration(handler)),
        );

        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });

    it('is 404, not 401, when no secret is configured', async () => {
        // An integration with no secret set is not "locked", it is not exposed.
        // Answering 401 would confirm to an unauthenticated caller that this
        // integration exists and merely awaits configuration.
        const handler = vi.fn(async () => undefined);
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(webhookIntegration(handler), null),
        );

        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });

    it('is 404 when the integration does not declare the webhook capability', async () => {
        const handler = vi.fn(async () => undefined);
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(webhookIntegration(handler, {})),
        );

        expect(res.status).toBe(404);
        expect(handler).not.toHaveBeenCalled();
    });

    it('is 404 when the integration implements no handleWebhook', async () => {
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(webhookIntegration(undefined)),
        );

        expect(res.status).toBe(404);
    });

    it('is 404 for an unknown integration id', async () => {
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'nope', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(undefined),
        );

        expect(res.status).toBe(404);
    });

    it('answers 500 without leaking the handler error message', async () => {
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            makeDeps(
                webhookIntegration(async () => {
                    throw new Error('db password is hunter2');
                }),
            ),
        );

        expect(res.status).toBe(500);
        expect(await res.text()).not.toContain('hunter2');
    });
});

describe('a wrong secret', () => {
    const good = () => webhookIntegration(vi.fn(async () => ({ ok: true })));

    it('answers 404, not 401 — 401-vs-404 enumerates which integrations are CONFIGURED', async () => {
        // The module docstring already promised an unauthenticated caller
        // cannot enumerate integrations. It held for unconfigured ones and not
        // for configured ones: a wrong secret said 401 while an absent secret
        // said 404, which is precisely the oracle the promise rules out.
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            makeDeps(good()),
        );
        expect(res.status).toBe(404);
    });

    it('is rate limited per IP, so the shared secret cannot be brute forced', async () => {
        const checkRate = vi.fn(async () => ({ allowed: true }));
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            { ...makeDeps(good()), checkRate },
        );
        expect(checkRate).toHaveBeenCalled();
        // 404, not 429 — see the enumeration test below for why the status must
        // not change once the budget is exhausted.
        expect(res.status).toBe(404);
    });

    it('an EXHAUSTED budget refuses before doing any work', async () => {
        // The counter alone only records that brute force happened. What bounds
        // it is refusing early: no registry lookup, no secret read, no
        // comparison. Asserting on the response status alone would pass against
        // code that did all the work and then returned 404.
        const readSecret = vi.fn(async () => SECRET);
        const getIntegration = vi.fn(() => good());
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            {
                ...makeDeps(good()),
                getIntegration,
                readSecret,
                peekRate: async () => ({ allowed: false }),
            },
        );
        expect(res.status).toBe(404);
        expect(getIntegration).not.toHaveBeenCalled();
        expect(readSecret).not.toHaveBeenCalled();
    });

    it('EXHAUSTED budget is indistinguishable between a real integration and a bogus id', async () => {
        // The whole 404-everywhere design exists so an unauthenticated caller
        // cannot learn which integrations exist and are configured. The rate
        // limiter re-opened exactly that hole: it was consulted ONLY after the
        // secret comparison, and answered 429 when exhausted. So a configured
        // integration returned 404 x20 then 429, while a nonexistent id
        // returned 404 forever — a reliable oracle for "this id is real and has
        // a secret", which is the fact the design promises to hide.
        const exhausted = { peekRate: async () => ({ allowed: false }) };
        const real = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            { ...makeDeps(good()), ...exhausted },
        );
        const bogus = await dispatchIntegrationWebhook(
            { integrationId: 'no-such-thing', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            { ...makeDeps(undefined), ...exhausted },
        );
        expect(real.status).toBe(bogus.status);
        expect(await real.text()).toBe(await bogus.text());
    });

    it('the request that TIPS the budget over is still an ordinary 404', async () => {
        // The exact shape of the original oracle, and the one an exhausted-peek
        // test cannot reach: the peek still allows (budget not yet spent), the
        // consume comes back not-allowed, and the old code turned THAT into a
        // 429. A bogus id never reaches the consume at all, so the two answers
        // diverged precisely on the request that crosses the limit.
        const tipping = {
            peekRate: async () => ({ allowed: true }),
            checkRate: async () => ({ allowed: false }),
        };
        const real = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            { ...makeDeps(good()), ...tipping },
        );
        const bogus = await dispatchIntegrationWebhook(
            { integrationId: 'no-such-thing', clientIp: '1.2.3.4', request: request({}, 'wrong') },
            { ...makeDeps(undefined), ...tipping },
        );
        expect(real.status).toBe(404);
        expect(real.status).toBe(bogus.status);
        expect(await real.text()).toBe(await bogus.text());
    });

    it('spends the budget on unknown ids too, so probing is bounded like a bad secret', async () => {
        const checkRate = vi.fn(async () => ({ allowed: true }));
        await dispatchIntegrationWebhook(
            { integrationId: 'no-such-thing', clientIp: '1.2.3.4', request: request({}, 'x') },
            { ...makeDeps(undefined), checkRate },
        );
        // Without this, id-enumeration is free and unbounded while secret
        // guessing is capped — the cheaper attack goes unmetered.
        expect(checkRate).toHaveBeenCalled();
    });

    it('does not spend the budget on a CORRECT secret', async () => {
        const checkRate = vi.fn(async () => ({ allowed: true }));
        await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: request({}) },
            { ...makeDeps(good()), checkRate },
        );
        // A busy legitimate sender must never lock itself out.
        expect(checkRate).not.toHaveBeenCalled();
    });
});

describe('body size', () => {
    it('refuses an oversized body by its declared length, before buffering it', async () => {
        const oversized = new Request('https://host/api/plugin-webhooks/sonarr-relay', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-plugin-webhook-secret': SECRET,
                'content-length': String(50_000_000),
            },
            body: '{}',
        });
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.4', request: oversized },
            makeDeps(webhookIntegration(vi.fn(async () => ({ ok: true })))),
        );
        expect(res.status).toBe(413);
    });

    // C17 (2026-09-16 fix plan): the old guard read the WHOLE body via
    // `.text()` before comparing `raw.length` against MAX_BODY_BYTES — the
    // declared-Content-Length precheck above is the only thing that ran
    // BEFORE any read, so a lying/missing Content-Length still let the host
    // buffer up to the adapter ceiling. Drives a genuinely STREAMED body (not
    // pre-buffered) whose Content-Length understates the real size, so only
    // the byte-counting streamed reader (bounded-body-reader.ts) — not the
    // cheap declared-length precheck — can catch it.
    it('rejects a genuinely streamed oversized body (413) even when Content-Length LIES (understates it), before the body is fully read', async () => {
        const encoder = new TextEncoder();
        const realBody = JSON.stringify({ padding: 'x'.repeat(1_500_000) }); // over the 1 MB cap
        const chunkSize = 65536;
        let offset = 0;
        const drainTracker = { reachedEnd: false };
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                // Real per-chunk delay (see bounded-body-reader.test.ts's own
                // `makeSlowStream`) so the consumer's cancel() has a chance to
                // run BETWEEN chunks instead of undici draining the whole
                // source eagerly before the reader gets a turn.
                await new Promise((r) => setTimeout(r, 1));
                if (offset >= realBody.length) {
                    drainTracker.reachedEnd = true;
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(realBody.slice(offset, offset + chunkSize)));
                offset += chunkSize;
            },
        });
        const lying = new Request('https://host/api/plugin-webhooks/sonarr-relay', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-plugin-webhook-secret': SECRET,
                'content-length': '10', // lies — claims a tiny body
            },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const handler = vi.fn(async () => ({ ok: true }));
        const res = await dispatchIntegrationWebhook(
            { integrationId: 'sonarr-relay', clientIp: '1.2.3.5', request: lying },
            makeDeps(webhookIntegration(handler)),
        );

        expect(res.status).toBe(413);
        // The finding is specifically that the body must never be FULLY
        // buffered — assert the reader was never drained to completion, not
        // merely that the status is 413.
        expect(drainTracker.reachedEnd).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
});
