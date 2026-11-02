// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const launcher = resolve('deploy/docker/start-proxy.sh');
function run(runtime?: string, native = true, bundle = true, fetchStatus = 0) {
    const root = mkdtempSync(join(tmpdir(), 'proxy-selector-'));
    mkdirSync(join(root, 'build'));
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(
        join(root, 'scripts/fetch-ffmpeg.sh'),
        `#!/bin/sh\necho fetched > fetched\nexit ${fetchStatus}\n`,
    );
    writeFileSync(join(root, 'bin/node'), '#!/bin/sh\nprintf "%s\\n" "$@" > selected-ts\n', {
        mode: 0o755,
    });
    if (bundle) writeFileSync(join(root, 'build/stream-proxy.js'), '');
    if (native)
        writeFileSync(
            join(root, 'build/lumastra-livetv-proxy'),
            '#!/bin/sh\nprintf "%s\\n" "$@" > selected-rust\n',
            { mode: 0o755 },
        );
    const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    };
    delete env.LIVETV_PROXY_RUNTIME;
    if (runtime !== undefined) env.LIVETV_PROXY_RUNTIME = runtime;
    try {
        const result = spawnSync('/bin/sh', [launcher], { cwd: root, env, encoding: 'utf8' });
        return {
            status: result.status,
            fetched: existsSync(join(root, 'fetched')),
            ts: existsSync(join(root, 'selected-ts'))
                ? readFileSync(join(root, 'selected-ts'), 'utf8')
                : null,
            rust: existsSync(join(root, 'selected-rust'))
                ? readFileSync(join(root, 'selected-rust'), 'utf8')
                : null,
        };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

describe('Live TV runtime selection', () => {
    it('lets Rust retry a temporarily unavailable read-only FFmpeg cache', () => {
        expect(run(undefined, true, true, 1)).toMatchObject({ status: 0, rust: '--serve\n' });
    });

    it('runs the native operational server by default', () => {
        expect(run()).toEqual({ status: 0, fetched: true, ts: null, rust: '--serve\n' });
        expect(run('rust')).toEqual({ status: 0, fetched: true, ts: null, rust: '--serve\n' });
    });
    it('rejects the retired TypeScript runtime without executing its bundle', () => {
        expect(run('typescript')).toEqual({ status: 64, fetched: false, ts: null, rust: null });
    });
    it('fails closed when the native binary is missing, also by default', () => {
        expect(run('rust', false)).toEqual({ status: 78, fetched: false, ts: null, rust: null });
        expect(run(undefined, false)).toEqual({
            status: 78,
            fetched: false,
            ts: null,
            rust: null,
        });
    });
    it('accepts the runtime name in any case and with stray whitespace', () => {
        expect(run(' Rust ')).toEqual({ status: 0, fetched: true, ts: null, rust: '--serve\n' });
        expect(run('TypeScript')).toMatchObject({ status: 64, ts: null });
    });
    it('treats an empty value as the default', () => {
        expect(run('')).toEqual({ status: 0, fetched: true, ts: null, rust: '--serve\n' });
    });
    it('rejects unknown runtime values before fetching anything', () => {
        expect(run('unknown')).toEqual({ status: 64, fetched: false, ts: null, rust: null });
    });
});
