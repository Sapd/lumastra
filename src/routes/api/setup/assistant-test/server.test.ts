// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/assistant-test — the "send one tiny message"
 * chat probe. Verifies validation, the provider→request mapping (URL + headers +
 * default model), and the ok / error result shapes. fetch is mocked; no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
}));

const openaiOk = (text: string) => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }] }),
});
const anthropicOk = (text: string) => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
});

const callPost = async (body: unknown) => {
    const { POST } = await import('./+server.js');
    return (POST as (event: unknown) => Promise<Response>)({
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    });
};

describe('POST /api/setup/assistant-test', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFetch.mockResolvedValue(openaiOk('OK'));
    });

    it('rejects an unknown provider', async () => {
        expect((await callPost({ provider: 'nope', apiKey: 'k' })).status).toBe(422);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a missing api key', async () => {
        expect((await callPost({ provider: 'openai', apiKey: '' })).status).toBe(422);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('hits OpenAI chat/completions with the default model + bearer auth', async () => {
        const body = await (await callPost({ provider: 'openai', apiKey: 'sk' })).json();
        expect(body).toEqual({ ok: true, model: 'gpt-4o-mini', reply: 'OK' });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
            'Bearer sk',
        );
        expect(JSON.parse((init as { body: string }).body)).toMatchObject({ model: 'gpt-4o-mini' });
    });

    it('hits Anthropic messages with x-api-key + version and default model', async () => {
        mockFetch.mockResolvedValue(anthropicOk('OK'));
        const body = await (await callPost({ provider: 'anthropic', apiKey: 'sk-ant' })).json();
        expect(body).toEqual({ ok: true, model: 'claude-opus-4-8', reply: 'OK' });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.anthropic.com/v1/messages');
        const headers = (init as { headers: Record<string, string> }).headers;
        expect(headers['x-api-key']).toBe('sk-ant');
        expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('honours an explicit model override', async () => {
        await callPost({ provider: 'openai', apiKey: 'sk', model: 'gpt-4o' });
        expect(JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body).model).toBe(
            'gpt-4o',
        );
    });

    it('surfaces a provider error on a non-2xx response', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'invalid x-api-key' } }),
        });
        const body = await (await callPost({ provider: 'anthropic', apiKey: 'bad' })).json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/API key/);
    });

    it('returns ok:false when the response has no completion text', async () => {
        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [] }) });
        const body = await (await callPost({ provider: 'openai', apiKey: 'sk' })).json();
        expect(body.ok).toBe(false);
    });

    it('returns ok:false when the fetch throws', async () => {
        mockFetch.mockRejectedValue(
            Object.assign(new Error('private-key'), { code: 'ECONNREFUSED' }),
        );
        const body = await (await callPost({ provider: 'openai', apiKey: 'k' })).json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/connection refused/i);
        expect(body.error).not.toContain('private-key');
    });

    it.each(['openai', 'anthropic'])('gives a safe TLS remedy for %s', async (provider) => {
        mockFetch.mockRejectedValue(
            new TypeError('key-secret', {
                cause: Object.assign(new Error('user:password'), {
                    code: 'SELF_SIGNED_CERT_IN_CHAIN',
                }),
            }),
        );
        const body = await (await callPost({ provider, apiKey: 'key-secret' })).json();
        expect(body.error).toContain('NODE_EXTRA_CA_CERTS');
        expect(body.error).not.toMatch(/key-secret|user:password/);
    });

    it('never echoes an upstream error body', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ detail: 'key-secret user:password' }),
        });
        const body = await (await callPost({ provider: 'openai', apiKey: 'key-secret' })).json();
        expect(body.error).not.toMatch(/key-secret|user:password/);
        expect(body.error).toMatch(/address.*settings/i);
        expect(body.error).not.toMatch(/embedding|dimension|model/i);
    });
});
