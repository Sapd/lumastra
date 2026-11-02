// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';

export interface NativeProxyFixture {
    child: ChildProcess;
    ingestPid(): number | undefined;
    status(): Promise<{
        channels: Array<{ channelId: string; viewers: number; segmentCount?: number }>;
    }>;
    stop(): Promise<void>;
}
/** Test-only process launcher; never silently substitutes another implementation. */
export async function startNativeProxy(port: number): Promise<NativeProxyFixture> {
    const binary =
        process.env.NATIVE_PROXY_BINARY ??
        [
            resolve('build/lumastra-livetv-proxy'),
            resolve('native/livetv-proxy/target/debug/lumastra-livetv-proxy'),
        ].find(existsSync);
    if (!binary)
        throw new Error(
            'Build the Rust proxy before running playback integration tests (npm run build:proxy)',
        );
    const child = spawn(binary, ['--serve'], {
        env: { ...process.env, PORT: String(port), LIVETV_SHUTDOWN_DRAIN_SECONDS: '0' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr?.on('data', (data: Buffer) => {
        errors = (errors + data.toString()).slice(-4000);
    });
    const status = async (): Promise<{
        channels: Array<{ channelId: string; viewers: number; segmentCount?: number }>;
        ffmpegAvailable: boolean;
    }> => {
        const response = await fetch(`http://127.0.0.1:${port}/status`, {
            headers: { 'x-proxy-secret': process.env.STREAM_PROXY_SECRET ?? '' },
            signal: AbortSignal.timeout(1000),
        });
        if (!response.ok) throw new Error(`Proxy status ${response.status}`);
        return response.json();
    };
    const stop = async (): Promise<void> => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
            await exited;
        } finally {
            clearTimeout(timer);
        }
    };
    const ingestPid = (): number | undefined => {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], { encoding: 'utf8' })
            .trim()
            .split('\n');
        const row = rows
            .map((line) => line.trim().split(/\s+/))
            .find((parts) => Number(parts[1]) === child.pid && /ffmpeg$/.test(parts[2] ?? ''));
        return row ? Number(row[0]) : undefined;
    };
    const deadline = Date.now() + 15000;
    try {
        while (Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`Native proxy exited: ${errors}`);
            try {
                if ((await status()).ffmpegAvailable) return { child, status, stop, ingestPid };
            } catch {
                /* Wait for listener and capability probe. */
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Native proxy did not become ready: ${errors}`);
    } catch (error) {
        await stop();
        throw error;
    }
}
