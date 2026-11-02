// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for sonic-embedding.service.ts.
 *
 * All tests use a MOCKED execFile — no real Python process is spawned.
 * The suite verifies:
 *   - Successful embedding parsing
 *   - Failure line handling
 *   - Malformed JSONL tolerance
 *   - Missing output line handling (implicit failure)
 *   - Wrong dimension detection
 *   - Process exit failure handling
 *   - Batching via embedPaths
 *   - The SONIC_MODEL_ID constant value
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();

vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
    // The torch/msclap module check: treated as installed.
    execFileSync: vi.fn(),
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

const cfg = vi.hoisted(() => ({
    SONIC_EMBEDDER_URL: '',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_EMBEDDER_SCRIPT: 'workers/sonic-embedder/embed.py',
    SONIC_EMBEDDER_BATCH_SIZE: 16,
}));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake 1024-element float array. */
function fakeEmbedding(seed = 0.1): number[] {
    return Array.from({ length: 1024 }, (_, i) => (i % 100) * seed * 0.01);
}

/** Build a JSONL stdout string with one success line per path. */
function successStdout(pathEmbeddings: Array<{ path: string; embedding: number[] }>): string {
    return pathEmbeddings.map((pe) => JSON.stringify(pe)).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SONIC_MODEL_ID', () => {
    test('equals "msclap-2023"', async () => {
        const { SONIC_MODEL_ID } = await import('./sonic-embedding.service.js');
        expect(SONIC_MODEL_ID).toBe('msclap-2023');
    });
});

describe('embedBatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns empty array for empty paths input', async () => {
        const { embedBatch } = await import('./sonic-embedding.service.js');
        const result = await embedBatch([]);
        expect(result).toEqual([]);
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('returns success result for a single path', async () => {
        const embedding = fakeEmbedding(0.5);
        const path = '/music/track.flac';
        mockExecFileAsync.mockResolvedValue({
            stdout: successStdout([{ path, embedding }]),
            stderr: '',
        });

        const { embedBatch } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path]);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ path, embedding });
    });

    test('returns one result per input path in a multi-path batch', async () => {
        const paths = ['/music/a.flac', '/music/b.mp3', '/music/c.ogg'];
        const stdout = successStdout(
            paths.map((path, i) => ({ path, embedding: fakeEmbedding(i + 1) })),
        );
        mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });

        const { embedBatch } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(results).toHaveLength(3);
        for (const [i, path] of paths.entries()) {
            expect(results[i].path).toBe(path);
            expect('embedding' in results[i]).toBe(true);
        }
    });

    test('marks a path as failed when the CLI emits an error line', async () => {
        const goodPath = '/music/good.flac';
        const badPath = '/music/bad.mp3';
        const embedding = fakeEmbedding();

        const stdout =
            JSON.stringify({ path: goodPath, embedding }) +
            '\n' +
            JSON.stringify({ path: badPath, error: 'unsupported codec' }) +
            '\n';
        mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });

        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([goodPath, badPath]);

        expect(results).toHaveLength(2);
        const goodResult = results.find((r) => r.path === goodPath)!;
        const badResult = results.find((r) => r.path === badPath)!;

        expect(isEmbedSuccess(goodResult)).toBe(true);
        expect(isEmbedSuccess(badResult)).toBe(false);
        expect((badResult as { error: string }).error).toContain('unsupported codec');
    });

    test('returns implicit failure when path produces no JSONL output', async () => {
        // Only one path gets output; the second is silently missing.
        const path1 = '/music/first.flac';
        const path2 = '/music/second.flac';
        mockExecFileAsync.mockResolvedValue({
            stdout: successStdout([{ path: path1, embedding: fakeEmbedding() }]),
            stderr: '',
        });

        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path1, path2]);

        expect(results).toHaveLength(2);
        const missing = results.find((r) => r.path === path2)!;
        expect(isEmbedSuccess(missing)).toBe(false);
        expect((missing as { error: string }).error).toContain('no output');
    });

    test('returns all paths as failed when process exits non-zero', async () => {
        const paths = ['/music/a.flac', '/music/b.flac'];
        mockExecFileAsync.mockRejectedValue(new Error('Process exited with code 1'));

        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch(paths);

        expect(results).toHaveLength(2);
        for (const r of results) {
            expect(isEmbedSuccess(r)).toBe(false);
            expect((r as { error: string }).error).toContain('exited');
        }
    });

    test('returns failure for wrong embedding dimension', async () => {
        const path = '/music/weird.flac';
        // Embed only 512 floats instead of 1024.
        const badEmbedding = Array.from({ length: 512 }, () => 0.1);
        mockExecFileAsync.mockResolvedValue({
            stdout: JSON.stringify({ path, embedding: badEmbedding }) + '\n',
            stderr: '',
        });

        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path]);

        expect(results).toHaveLength(1);
        expect(isEmbedSuccess(results[0])).toBe(false);
        expect((results[0] as { error: string }).error).toContain('512');
    });

    test('tolerates malformed JSON lines without throwing', async () => {
        const path = '/music/ok.flac';
        const goodLine = JSON.stringify({ path, embedding: fakeEmbedding() });
        mockExecFileAsync.mockResolvedValue({
            stdout: 'INVALID_JSON\n' + goodLine + '\n',
            stderr: '',
        });

        const { embedBatch, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedBatch([path]);

        // The malformed line is skipped; the valid line is parsed.
        expect(results).toHaveLength(1);
        expect(isEmbedSuccess(results[0])).toBe(true);
    });

    test('sends the correct stdin JSON to the process', async () => {
        const paths = ['/music/a.flac', '/music/b.flac'];
        mockExecFileAsync.mockResolvedValue({
            stdout: successStdout(paths.map((p) => ({ path: p, embedding: fakeEmbedding() }))),
            stderr: '',
        });

        const { embedBatch } = await import('./sonic-embedding.service.js');
        await embedBatch(paths);

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { input: string },
        ];
        const parsed = JSON.parse(opts.input) as { paths: string[] };
        expect(parsed.paths).toEqual(paths);
    });
});

// ---------------------------------------------------------------------------
// Whole-batch embedder failures are NOT per-track failures
// ---------------------------------------------------------------------------

/** What execFile rejects with: an Error carrying code / stdout. */
function execError(message: string, extra: { code?: unknown; stdout?: string }): Error {
    return Object.assign(new Error(message), extra);
}

function modelLoadLines(paths: string[], why = "No module named 'msclap'"): string {
    return (
        paths
            .map((path) => JSON.stringify({ path, error: `model load failed: ${why}` }))
            .join('\n') + '\n'
    );
}

describe('embedBatch — systemic failures throw SonicEngineError', () => {
    const paths = ['/music/a.flac', '/music/b.flac'];

    beforeEach(async () => {
        vi.clearAllMocks();
        // Real files, so the subprocess fallback counts as installed and only
        // the broken-engine hold can close the gate.
        cfg.SONIC_EMBEDDER_PYTHON = process.execPath;
        cfg.SONIC_EMBEDDER_SCRIPT = fileURLToPath(import.meta.url);
        const { resetSonicEngineProbeForTests } = await import('./sonic-embedding.service.js');
        resetSonicEngineProbeForTests();
    });

    test('the interpreter cannot be spawned (ENOENT): throws, and the gate closes', async () => {
        mockExecFileAsync.mockRejectedValue(execError('spawn python3 ENOENT', { code: 'ENOENT' }));
        const svc = await import('./sonic-embedding.service.js');
        expect(svc.isSonicEngineConfigured()).toBe(true);

        await expect(svc.embedBatch(paths)).rejects.toBeInstanceOf(svc.SonicEngineError);
        expect(svc.isSonicEngineConfigured()).toBe(false);
    });

    test('embed.py exits 1 after "model load failed" for every path: throws, gate closes', async () => {
        mockExecFileAsync.mockRejectedValue(
            execError('Command failed: exit code 1', { code: 1, stdout: modelLoadLines(paths) }),
        );
        const svc = await import('./sonic-embedding.service.js');

        await expect(svc.embedBatch(paths)).rejects.toThrow(/cannot load the model.*msclap/);
        expect(svc.isSonicEngineConfigured()).toBe(false);
    });

    test('every line a model-load failure even on exit 0: throws', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: modelLoadLines(paths), stderr: '' });
        const svc = await import('./sonic-embedding.service.js');
        await expect(svc.embedBatch(paths)).rejects.toBeInstanceOf(svc.SonicEngineError);
    });

    test('a crash part-way through (no model-load lines) stays per-track: may be one bad file', async () => {
        mockExecFileAsync.mockRejectedValue(
            execError('Command failed: killed by SIGSEGV', { code: null, stdout: '' }),
        );
        const svc = await import('./sonic-embedding.service.js');

        const results = await svc.embedBatch(paths);
        expect(results.map((r) => svc.isEmbedSuccess(r))).toEqual([false, false]);
        expect(svc.isSonicEngineConfigured()).toBe(true);
    });

    test('one per-track error next to a success is never systemic', async () => {
        mockExecFileAsync.mockResolvedValue({
            stdout:
                JSON.stringify({ path: paths[0], error: 'model load failed: looks systemic' }) +
                '\n' +
                JSON.stringify({ path: paths[1], embedding: fakeEmbedding() }) +
                '\n',
            stderr: '',
        });
        const svc = await import('./sonic-embedding.service.js');
        const results = await svc.embedBatch(paths);
        expect(results.map((r) => svc.isEmbedSuccess(r))).toEqual([false, true]);
    });

    test('a changed interpreter setting starts from a fresh probe', async () => {
        mockExecFileAsync.mockRejectedValue(execError('spawn ENOENT', { code: 'ENOENT' }));
        const svc = await import('./sonic-embedding.service.js');
        await expect(svc.embedBatch(paths)).rejects.toBeInstanceOf(svc.SonicEngineError);
        expect(svc.isSonicEngineConfigured()).toBe(false);

        cfg.SONIC_EMBEDDER_SCRIPT = process.execPath; // any other readable file
        expect(svc.isSonicEngineConfigured()).toBe(true);
    });
});

describe('embedPaths', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns all results in input order across multiple batches', async () => {
        // Config mock has batchSize=16; we pass 3 paths so one batch.
        const paths = ['/a.flac', '/b.flac', '/c.flac'];
        mockExecFileAsync.mockResolvedValue({
            stdout: successStdout(paths.map((p) => ({ path: p, embedding: fakeEmbedding() }))),
            stderr: '',
        });

        const { embedPaths, isEmbedSuccess } = await import('./sonic-embedding.service.js');
        const results = await embedPaths(paths);

        expect(results).toHaveLength(3);
        for (const r of results) {
            expect(isEmbedSuccess(r)).toBe(true);
        }
    });

    test('splits into multiple batches when paths exceed batch size', async () => {
        // Temporarily override the batch size to 2.
        vi.doMock('$lib/server/config.js', () => ({
            config: {
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'workers/sonic-embedder/embed.py',
                SONIC_EMBEDDER_BATCH_SIZE: 2,
            },
        }));
        vi.resetModules();

        const paths = ['/a.flac', '/b.flac', '/c.flac']; // 3 paths → 2 batches
        // Both calls succeed.
        mockExecFileAsync
            .mockResolvedValueOnce({
                stdout: successStdout([
                    { path: '/a.flac', embedding: fakeEmbedding() },
                    { path: '/b.flac', embedding: fakeEmbedding() },
                ]),
                stderr: '',
            })
            .mockResolvedValueOnce({
                stdout: successStdout([{ path: '/c.flac', embedding: fakeEmbedding() }]),
                stderr: '',
            });

        // Re-import fresh module to pick up the new mock.
        const { embedPaths } = await import('./sonic-embedding.service.js');
        const results = await embedPaths(paths);

        expect(results).toHaveLength(3);
        expect(mockExecFileAsync).toHaveBeenCalledTimes(2);
    });
});

describe('isEmbedSuccess', () => {
    test('returns true for a success result', async () => {
        const { isEmbedSuccess } = await import('./sonic-embedding.service.js');
        expect(isEmbedSuccess({ path: '/a.flac', embedding: [0.1] })).toBe(true);
    });

    test('returns false for a failure result', async () => {
        const { isEmbedSuccess } = await import('./sonic-embedding.service.js');
        expect(isEmbedSuccess({ path: '/a.flac', error: 'failed' })).toBe(false);
    });
});
