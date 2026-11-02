// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSaveConfig = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

function call(body: unknown) {
    return import('./+server.js').then(({ POST }) =>
        (POST as (event: unknown) => Promise<Response>)({
            request: new Request('http://localhost/test', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        }),
    );
}

describe('POST /api/setup/assistant', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('openai provider writes OPENAI_CHAT_API_KEY, not ANTHROPIC_API_KEY', async () => {
        const res = await call({
            enabled: true,
            provider: 'openai',
            apiKey: 'sk-test-123',
            model: 'gpt-4o-mini',
        });
        const body = await res.json();

        expect(body).toEqual({ ok: true });
        expect(mockSaveConfig).toHaveBeenCalledWith({
            FEATURE_AI_ASSISTANT: true,
            ASSISTANT_PROVIDER: 'openai',
            OPENAI_CHAT_API_KEY: 'sk-test-123',
            OPENAI_CHAT_MODEL: 'gpt-4o-mini',
        });
        expect(mockSaveConfig).not.toHaveBeenCalledWith(
            expect.objectContaining({ ANTHROPIC_API_KEY: expect.anything() }),
        );
    });

    it('anthropic provider writes ANTHROPIC_API_KEY, not OPENAI_CHAT_API_KEY', async () => {
        const res = await call({
            enabled: true,
            provider: 'anthropic',
            apiKey: 'sk-ant-test-123',
            model: 'claude-opus-4-8',
        });
        const body = await res.json();

        expect(body).toEqual({ ok: true });
        expect(mockSaveConfig).toHaveBeenCalledWith({
            FEATURE_AI_ASSISTANT: true,
            ASSISTANT_PROVIDER: 'anthropic',
            ANTHROPIC_API_KEY: 'sk-ant-test-123',
            ANTHROPIC_CHAT_MODEL: 'claude-opus-4-8',
        });
        expect(mockSaveConfig).not.toHaveBeenCalledWith(
            expect.objectContaining({ OPENAI_CHAT_API_KEY: expect.anything() }),
        );
    });

    it('does not blank an existing key when apiKey is omitted', async () => {
        await call({ enabled: true, provider: 'openai' });

        expect(mockSaveConfig).toHaveBeenCalledWith({
            FEATURE_AI_ASSISTANT: true,
            ASSISTANT_PROVIDER: 'openai',
        });
    });

    it('does not blank an existing key when apiKey is an empty string', async () => {
        await call({ enabled: true, provider: 'anthropic', apiKey: '   ' });

        expect(mockSaveConfig).toHaveBeenCalledWith({
            FEATURE_AI_ASSISTANT: true,
            ASSISTANT_PROVIDER: 'anthropic',
        });
    });

    it('maps enabled: false to FEATURE_AI_ASSISTANT: false', async () => {
        await call({ enabled: false, provider: 'openai' });

        expect(mockSaveConfig).toHaveBeenCalledWith({
            FEATURE_AI_ASSISTANT: false,
            ASSISTANT_PROVIDER: 'openai',
        });
    });

    it('rejects an invalid provider with 400 and does not call saveConfig', async () => {
        const res = await call({ enabled: true, provider: 'gemini' });

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });

    it('rejects a non-object body', async () => {
        const res = await call('not-json');

        expect(res.status).toBe(422);
        expect(mockSaveConfig).not.toHaveBeenCalled();
    });
});
