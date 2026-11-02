// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An uncommented `.env.example` sample key must read as "not configured".
 * OPENAI_API_KEY and VOYAGE_API_KEY already went through the placeholder
 * filter; ANTHROPIC_API_KEY, OPENAI_CHAT_API_KEY and EMBEDDING_API_KEY used
 * plain getString, so `sk-ant-your_…` counted as a real key: the assistant
 * picked Claude, and a custom embedding endpoint looked configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const KEYS = [
    'ANTHROPIC_API_KEY',
    'OPENAI_CHAT_API_KEY',
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
] as const;
type Key = (typeof KEYS)[number];

const ORIGINAL_ENV: Partial<Record<Key, string>> = {};
for (const key of KEYS) ORIGINAL_ENV[key] = process.env[key];

type ConfigModule = {
    config: Record<Key, string>;
    hasEmbeddingProvider: () => boolean;
};

async function loadConfig(envVars: Partial<Record<Key, string>>): Promise<ConfigModule> {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, envVars);
    vi.resetModules();
    return (await import('./config.js')) as unknown as ConfigModule;
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const key of KEYS) {
        if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = ORIGINAL_ENV[key];
    }
});

describe('AI keys ignore .env.example placeholders', () => {
    it.each([
        ['ANTHROPIC_API_KEY', 'sk-ant-your_anthropic_api_key'],
        ['OPENAI_CHAT_API_KEY', 'sk-your_openai_chat_api_key'],
        ['EMBEDDING_API_KEY', 'your_embedding_api_key'],
    ] as const)('%s=%s reads as unset', async (key, sample) => {
        const { config } = await loadConfig({ [key]: sample });
        expect(config[key]).toBe('');
    });

    it.each([
        ['ANTHROPIC_API_KEY', 'sk-ant-api03-realkey'],
        ['OPENAI_CHAT_API_KEY', 'local'],
        ['EMBEDDING_API_KEY', 'local-key'],
    ] as const)('%s keeps a real value', async (key, value) => {
        const { config } = await loadConfig({ [key]: value });
        expect(config[key]).toBe(value);
    });

    it('a custom embedding endpoint with a placeholder key is not an embedding provider', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'http://ollama:11434/v1',
            EMBEDDING_API_KEY: 'your_embedding_api_key',
        });
        expect(hasEmbeddingProvider()).toBe(false);
    });
});
