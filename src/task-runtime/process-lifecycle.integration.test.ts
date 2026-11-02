// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function waitForOutput(child: ChildProcess, logs: () => string, text: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!logs().includes(text)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
            throw new Error(`Missing ${text}: ${logs()}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
}

async function withProcess(
    body: string,
    check: (child: ChildProcess, logs: () => string) => Promise<void>,
): Promise<void> {
    // Node 24's source type stripping loads the same controller the production
    // bundle uses. No mock process/signal implementation participates here.
    const module = new URL('./process-lifecycle.ts', import.meta.url).href;
    const child = spawn(
        process.execPath,
        [
            '--input-type=module',
            '--eval',
            `
        import { createTaskProcessLifecycle } from ${JSON.stringify(module)};
        ${body}
    `,
        ],
        { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-8192);
        });
    try {
        await check(child, () => output);
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
    }
}

describe('standalone controller actual process signals', () => {
    it('survives repeated signals during startup and cleanup and cleans up exactly once', async () => {
        await withProcess(
            `
            const host = createTaskProcessLifecycle({
                drain: () => console.log('DRAIN'),
                cleanup: async () => {
                    console.log('CLEANUP_START');
                    await new Promise(resolve => setTimeout(resolve, 200));
                    console.log('CLEANUP_DONE');
                },
                failed: error => console.error(error),
                exit: code => process.exit(code),
                deadlineMs: 3000,
            });
            for (const signal of ['SIGTERM', 'SIGINT'])
                process.on(signal, () => { void host.shutdown(0); });
            setTimeout(() => host.startupFinished(), 300);
            console.log('STARTING');
        `,
            async (child, logs) => {
                await waitForOutput(child, logs, 'STARTING');
                const exited = once(child, 'exit');
                child.kill('SIGTERM');
                await waitForOutput(child, logs, 'DRAIN');
                child.kill('SIGTERM');
                child.kill('SIGINT');
                await waitForOutput(child, logs, 'CLEANUP_START');
                child.kill('SIGTERM');
                expect(await exited, logs()).toEqual([0, null]);
                expect(logs().match(/DRAIN/g)).toHaveLength(1);
                expect(logs().match(/CLEANUP_DONE/g)).toHaveLength(1);
            },
        );
    });

    it.each(['startup', 'cleanup'])(
        'exits nonzero with UNKNOWN when %s never settles',
        async (phase) => {
            await withProcess(
                `
            const host = createTaskProcessLifecycle({
                drain: () => console.log('DRAIN'),
                cleanup: async () => {
                    console.log('CLEANUP_START');
                    await new Promise(() => {});
                },
                failed: error => console.error(error.message),
                exit: code => process.exit(code),
                deadlineMs: 100,
            });
            process.on('SIGTERM', () => { void host.shutdown(0); });
            ${phase === 'cleanup' ? 'host.startupFinished();' : ''}
            setInterval(() => {}, 1000);
            console.log('STARTING');
        `,
                async (child, logs) => {
                    await waitForOutput(child, logs, 'STARTING');
                    const exited = once(child, 'exit');
                    child.kill('SIGTERM');
                    expect(await exited, logs()).toEqual([1, null]);
                    expect(logs()).toContain('cleanup outcome UNKNOWN');
                    expect(logs().includes('CLEANUP_START')).toBe(phase === 'cleanup');
                },
            );
        },
    );
});
