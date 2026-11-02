// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for embedTextQuery() in sonic-embedding.service.ts.
 *
 * All tests use a MOCKED execFile — no real Python process is spawned.
 * The suite verifies:
 *   - Returns null for empty/blank text.
 *   - Spawns the text script (SONIC_EMBEDDER_TEXT_SCRIPT) not the audio one.
 *   - Sends {"text": "..."} JSON as stdin.
 *   - Parses the 1024-float JSON array from stdout.
 *   - Returns null when the process fails (exits non-zero).
 *   - Returns null when stdout is empty.
 *   - Returns null when stdout is not a JSON array.
 *   - Returns null when the array has the wrong dimension.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();

vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
    promisify: (_fn: unknown) => mockExecFileAsync,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        SONIC_EMBEDDER_PYTHON: 'python3',
        SONIC_EMBEDDER_SCRIPT: 'workers/sonic-embedder/embed.py',
        SONIC_EMBEDDER_TEXT_SCRIPT: 'workers/sonic-embedder/embed_text.py',
        SONIC_EMBEDDER_BATCH_SIZE: 16,
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake 1024-element float array. */
function fakeEmbedding(seed = 0.1): number[] {
    return Array.from({ length: 1024 }, (_, i) => (i % 100) * seed * 0.01);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('embedTextQuery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns null for empty string', async () => {
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('');
        expect(result).toBeNull();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('returns null for whitespace-only string', async () => {
        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('   ');
        expect(result).toBeNull();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('spawns SONIC_EMBEDDER_TEXT_SCRIPT, not the audio script', async () => {
        const embedding = fakeEmbedding();
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery('calm piano');

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [_bin, args] = mockExecFileAsync.mock.calls[0] as [string, string[]];
        expect(args[0]).toBe('workers/sonic-embedder/embed_text.py');
    });

    test('sends {"text": "..."} JSON as stdin', async () => {
        const embedding = fakeEmbedding();
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery('calm piano');

        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { input: string },
        ];
        const parsed = JSON.parse(opts.input) as { text: string };
        expect(parsed.text).toBe('calm piano');
    });

    test('trims whitespace from the query before sending', async () => {
        const embedding = fakeEmbedding();
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        await embedTextQuery('  calm piano  ');

        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { input: string },
        ];
        const parsed = JSON.parse(opts.input) as { text: string };
        expect(parsed.text).toBe('calm piano');
    });

    test('returns a 1024-element float array on success', async () => {
        const embedding = fakeEmbedding(0.5);
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify(embedding) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('aggressive metal');

        expect(result).not.toBeNull();
        expect(result).toHaveLength(1024);
        expect(result![0]).toBeCloseTo(embedding[0], 6);
    });

    test('returns null when process exits non-zero', async () => {
        mockExecFileAsync.mockRejectedValue(new Error('Process exited with code 1'));

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).toBeNull();
    });

    test('returns null when stdout is empty', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).toBeNull();
    });

    test('returns null when stdout is not valid JSON', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: 'INVALID_JSON\n', stderr: '' });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).toBeNull();
    });

    test('returns null when stdout is a JSON object instead of array', async () => {
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify({ error: 'failed' }) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).toBeNull();
    });

    test('returns null when embedding has wrong dimension (512 instead of 1024)', async () => {
        const shortEmbedding = Array.from({ length: 512 }, () => 0.1);
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify(shortEmbedding) + '\n',
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).toBeNull();
    });

    test('handles stdout Buffer (not string) gracefully', async () => {
        const embedding = fakeEmbedding();
        mockExecFileAsync.mockResolvedValue({
            stdout: Buffer.from(JSON.stringify(embedding) + '\n'),
            stderr: '',
        });

        const { embedTextQuery } = await import('./sonic-embedding.service.js');
        const result = await embedTextQuery('calm piano');
        expect(result).not.toBeNull();
        expect(result).toHaveLength(1024);
    });
});
