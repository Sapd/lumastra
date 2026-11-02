// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const appRoot = resolve('.');
const launcher = join(appRoot, 'scripts/startup-migration.ts');
const tsx = createRequire(join(appRoot, 'package.json')).resolve('tsx');
const databaseImportSentinel = 'TEST_DATABASE_IMPORT_REACHED';
const credentials = ['migration-user', 'migration-secret', 'cache-user', 'cache-secret'];

interface LauncherResult {
    code: number | null;
    signal: string | null;
    output: string;
    databaseImports: string;
    timedOut: boolean;
}

/**
 * Run the real entry point outside the checkout so dotenv cannot fill in a
 * deliberately missing variable from a developer's .env. Only the dangerous DB
 * import boundary is intercepted; the launcher and endpoint validator run in a
 * fresh Node + tsx process, without Vitest's module graph or environment.
 *
 * The loader records AND refuses database imports, before any DB code can run.
 * This catches moving validation below an import even when that import would
 * happen not to open a socket. A valid-config control proves the seam is live.
 */
async function runLauncher(
    taskUrl: string | undefined,
    skipPreflight: boolean,
    moveAssertionAfterImports = false,
): Promise<LauncherResult> {
    const directory = await mkdtemp(join(tmpdir(), 'startup-migration-gate-'));
    const importLog = join(directory, 'database-imports.log');
    try {
        await writeFile(importLog, '');
        await writeFile(
            join(directory, 'register.mjs'),
            `import { register } from 'node:module';
register('./database-barrier.mjs', import.meta.url);
`,
        );
        await writeFile(
            join(directory, 'database-barrier.mjs'),
            `import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, nextResolve) {
    if (specifier.includes('/server/database/')) {
        appendFileSync(process.env.TEST_DATABASE_IMPORT_LOG, specifier + '\\n');
        throw new Error('${databaseImportSentinel}');
    }
    return nextResolve(specifier, context);
}
`,
        );

        let entryPoint = launcher;
        if (moveAssertionAfterImports) {
            // Mutate an owned fixture only. Relative imports still resolve to the
            // real source, including the unmodified endpoint validator.
            const source = await readFile(launcher, 'utf8');
            const assertion = '    assertValkeyEndpointConfiguration();';
            const importEnd =
                "        await import('../src/lib/server/preflight/config-doctor.js');";
            if (!source.includes(assertion) || !source.includes(importEnd)) {
                throw new Error('Update the import-order mutation fixture for the launcher');
            }
            const mutated = source
                .replace(assertion, '')
                .replace(importEnd, `${importEnd}\n${assertion}`);
            await mkdir(join(directory, 'scripts'));
            await symlink(join(appRoot, 'src'), join(directory, 'src'), 'dir');
            await symlink(join(appRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
            await writeFile(join(directory, 'package.json'), '{"type":"module"}');
            entryPoint = join(directory, 'scripts/startup-migration.ts');
            await writeFile(entryPoint, mutated);
        }

        const result = await new Promise<Omit<LauncherResult, 'databaseImports'>>(
            (resolveResult, reject) => {
                const child = spawn(
                    process.execPath,
                    [
                        '--import',
                        pathToFileURL(join(directory, 'register.mjs')).href,
                        '--import',
                        pathToFileURL(tsx).href,
                        entryPoint,
                    ],
                    {
                        cwd: directory,
                        env: {
                            PATH: process.env.PATH,
                            NODE_ENV: 'production',
                            TSX_TSCONFIG_PATH: join(appRoot, 'tsconfig.scripts.json'),
                            DATABASE_URL:
                                'postgres://migration-user:migration-secret@127.0.0.1:1/gate_test',
                            CACHE_URL: 'redis://cache-user:cache-secret@127.0.0.1:6379/0',
                            ...(taskUrl === undefined ? {} : { TASK_CACHE_URL: taskUrl }),
                            LUMASTRA_SKIP_PREFLIGHT: String(skipPreflight),
                            TEST_DATABASE_IMPORT_LOG: importLog,
                        },
                        stdio: ['ignore', 'pipe', 'pipe'],
                    },
                );
                let output = '';
                let timedOut = false;
                child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
                    output += chunk;
                });
                child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
                    output += chunk;
                });
                const timeout = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGKILL');
                }, 8000);
                child.once('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                child.once('close', (code, signal) => {
                    clearTimeout(timeout);
                    resolveResult({ code, signal, output, timedOut });
                });
            },
        );
        return { ...result, databaseImports: await readFile(importLog, 'utf8') };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

describe('startup migration mandatory Valkey topology gate', () => {
    for (const skipPreflight of [false, true]) {
        it.each([
            ['missing task URL', undefined, 'TASK_CACHE_URL is required'],
            [
                'invalid task URL',
                'redis://migration-user:migration-secret@127.0.0.1:invalid/1',
                'TASK_CACHE_URL must be a valid redis:// or rediss:// URL',
            ],
            [
                'same instance with a different logical database',
                'redis://migration-user:migration-secret@127.0.0.1:6379/1',
                'TASK_CACHE_URL and CACHE_URL must point to distinct Valkey instances',
            ],
        ])(
            `rejects %s before database imports (skip preflight: ${skipPreflight})`,
            async (_name, taskUrl, diagnostic) => {
                const result = await runLauncher(taskUrl, skipPreflight);
                expect(result.timedOut, result.output).toBe(false);
                expect(result.signal, result.output).toBeNull();
                expect(result.code, result.output).toBe(1);
                expect(result.output).toContain('ValkeyEndpointConfigurationError');
                expect(result.output).toContain(diagnostic);
                for (const credential of credentials) {
                    expect(result.output).not.toContain(credential);
                }
                expect(result.databaseImports, result.output).toBe('');
                expect(result.output).not.toContain(databaseImportSentinel);
            },
        );
    }

    it('proves a valid topology reaches the guarded database import', async () => {
        const result = await runLauncher('redis://127.0.0.1:6381/1', true);
        expect(result.timedOut, result.output).toBe(false);
        expect(result.code).toBe(1);
        expect(result.databaseImports).toMatch(/\/server\/database\/migrate-schema\.[jt]s/);
        expect(result.output).toContain(databaseImportSentinel);
    });

    it('detects moving the topology assertion below database imports', async () => {
        const result = await runLauncher(undefined, true, true);
        expect(result.timedOut, result.output).toBe(false);
        expect(result.code).toBe(1);
        expect(result.databaseImports).toMatch(/\/server\/database\/migrate-schema\.[jt]s/);
        expect(result.output).toContain(databaseImportSentinel);
        expect(result.output).not.toContain('TASK_CACHE_URL is required');
    });
});
