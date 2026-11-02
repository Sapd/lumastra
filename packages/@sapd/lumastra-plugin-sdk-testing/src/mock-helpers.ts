// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { HttpClient, NamespacedCache, FfmpegRunner, Logger } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// mockHttpClient
// ---------------------------------------------------------------------------

export interface MockHttpClient extends HttpClient {
    calls: Array<{ method: 'GET' | 'POST'; url: string; body?: unknown }>;
    setResponse(url: string, response: Response): void;
}

export function mockHttpClient(): MockHttpClient {
    const calls: Array<{
        method: 'GET' | 'POST';
        url: string;
        body?: unknown;
    }> = [];
    const responses = new Map<string, Response>();

    function makeResponse(url: string): Response {
        const preset = responses.get(url);
        if (preset) return preset;
        return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const client: MockHttpClient = {
        calls,
        setResponse(url: string, response: Response): void {
            responses.set(url, response);
        },
        async get(url: string): Promise<Response> {
            calls.push({ method: 'GET', url });
            return makeResponse(url);
        },
        async post(url: string, body: unknown): Promise<Response> {
            calls.push({ method: 'POST', url, body });
            return makeResponse(url);
        },
    };

    return client;
}

// ---------------------------------------------------------------------------
// mockCache
// ---------------------------------------------------------------------------

export interface MockCache extends NamespacedCache {
    store: Map<string, unknown>;
}

export function mockCache(): MockCache {
    const store = new Map<string, unknown>();

    return {
        store,
        async get<T>(key: string): Promise<T | null> {
            const v = store.get(key);
            return v === undefined ? null : (v as T);
        },
        async set<T>(key: string, value: T): Promise<void> {
            store.set(key, value);
        },
        async del(key: string): Promise<void> {
            store.delete(key);
        },
    };
}

// ---------------------------------------------------------------------------
// mockFfmpegRunner
//
// NOTE: `ctx.ffmpeg` no longer exists — it was a host stub that threw on first
// call and was removed rather than left as a promise. This helper stays for a
// plugin that shells out to ffmpeg through its OWN runner and wants to fake it
// in tests; it is no longer bound to anything on the context.
// ---------------------------------------------------------------------------

export interface MockFfmpegRunner extends FfmpegRunner {
    calls: string[][];
    setResult(result: { stdout: string; stderr: string; code: number }): void;
}

export function mockFfmpegRunner(): MockFfmpegRunner {
    const calls: string[][] = [];
    let _result = { stdout: '', stderr: '', code: 0 };

    return {
        calls,
        setResult(result: { stdout: string; stderr: string; code: number }): void {
            _result = result;
        },
        async run(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
            calls.push(args);
            return { ..._result };
        },
    };
}

// ---------------------------------------------------------------------------
// mockLogger
// ---------------------------------------------------------------------------

export interface MockLogger extends Logger {
    entries: Array<{
        level: 'info' | 'warn' | 'error' | 'debug';
        msg: string;
        meta?: object;
    }>;
}

export function mockLogger(): MockLogger {
    const entries: Array<{
        level: 'info' | 'warn' | 'error' | 'debug';
        msg: string;
        meta?: object;
    }> = [];

    const logger: MockLogger = {
        entries,
        info(msg: string, meta?: object): void {
            entries.push({ level: 'info', msg, meta });
        },
        warn(msg: string, meta?: object): void {
            entries.push({ level: 'warn', msg, meta });
        },
        error(msg: string, meta?: object): void {
            entries.push({ level: 'error', msg, meta });
        },
        debug(msg: string, meta?: object): void {
            entries.push({ level: 'debug', msg, meta });
        },
        child(): MockLogger {
            return logger;
        },
    };

    return logger;
}
