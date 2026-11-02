// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect } from 'vitest';

export const BINARY = process.env.NATIVE_PROXY_BINARY || resolve('build/lumastra-livetv-proxy');
export interface Vector {
    input: Record<string, unknown>;
    expected: unknown;
}

export function evaluate(vectors: Vector[]): void {
    const child = spawnSync(BINARY, ['--evaluate'], {
        input: vectors.map((v) => JSON.stringify(v.input)).join('\n') + '\n',
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10_000,
    });
    expect(
        child.error,
        'native binary must exist; build it before running conformance',
    ).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { result: unknown });
    expect(lines).toHaveLength(vectors.length);
    for (const [i, vector] of vectors.entries())
        expect(lines[i], JSON.stringify(vector.input)).toEqual({ result: vector.expected });
}
