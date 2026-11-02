// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * On a read-only FFMPEG_CACHE_DIR (the standalone Live TV proxy),
 * fetch-ffmpeg.sh used to spin its full ~300s lock-acquire loop
 * (scripts/fetch-ffmpeg.sh:57-69, 150 * 2s) before giving up: every
 * `mkdir "$LOCK_DIR"` attempt fails with EROFS, `ffmpeg_ready` never becomes
 * true (nothing can ever install), so the loop only ever times out. Because
 * deploy/docker/start-proxy.sh runs this SYNCHRONOUSLY before `exec node`,
 * that is ~5 minutes of the proxy serving nothing on every single boot —
 * precisely the state right after this batch's :ro split is applied, before
 * web/worker have populated the shared cache.
 *
 * The script is idempotent and NON-FATAL by design (every failure path
 * `exit 0`), so this is a bounded self-heal, not an outage loop — but
 * "bounded at 5 minutes per boot" is still worth cutting to "immediate".
 *
 * Fix: bail out (log + exit 0) as soon as FFMPEG_CACHE_DIR is confirmed
 * unwritable, before ever entering the lock-acquire loop.
 *
 * This test invokes the REAL script as a subprocess (`sh`, matching how
 * deploy/docker/start-proxy.sh calls it) against a real read-only temp
 * directory, with a short `timeout` so the OLD (unfixed) behavior — which
 * would otherwise hang for the full ~300s — fails fast and observably
 * instead of stalling the test run.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    chmodSync,
    rmSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    utimesSync,
    existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'fetch-ffmpeg.sh');

// Generous vs. the fix's near-instant exit; tiny vs. the bug's ~300s spin —
// if the script is still running at this point, spawnSync kills it and we
// observe that as a timeout, which is itself the RED signal for the old code.
const TEST_TIMEOUT_MS = 5000;

describe('fetch-ffmpeg.sh: read-only FFMPEG_CACHE_DIR (P4 fix-round-1 Important 3)', () => {
    it('bails immediately instead of spinning the ~300s lock-acquire loop', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fetch-ffmpeg-ro-'));
        try {
            // Read + execute, no write — the same shape `access(2)`/`[ -w ]`
            // sees for a Docker `:ro` bind mount, and (unlike root) this
            // process is not exempt from the permission bits.
            chmodSync(dir, 0o555);

            const start = Date.now();
            const result = spawnSync('sh', [SCRIPT], {
                env: {
                    ...process.env,
                    FFMPEG_AUTO_DOWNLOAD: 'true',
                    FFMPEG_CACHE_DIR: dir,
                    // Force ffmpeg_ready() to fail for a reason OTHER than the
                    // read-only mount, so the test can't pass by accident via
                    // step 2's unrelated short-circuit.
                    FFMPEG_PATH: join(dir, 'ffmpeg'),
                    FFPROBE_PATH: join(dir, 'ffprobe'),
                },
                timeout: TEST_TIMEOUT_MS,
                encoding: 'utf8',
            });
            const elapsedMs = Date.now() - start;

            expect(
                result.signal,
                `script was still running and had to be killed after ${TEST_TIMEOUT_MS}ms ` +
                    `(the pre-fix ~300s lock-wait loop) — stdout so far: ${result.stdout}`,
            ).toBeNull();
            expect(result.status, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
            expect(elapsedMs).toBeLessThan(TEST_TIMEOUT_MS);
            expect(result.stdout).toMatch(/not writable/i);
        } finally {
            chmodSync(dir, 0o755);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('still installs normally when FFMPEG_AUTO_DOWNLOAD=false on a read-only dir (opt-out path unaffected)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'fetch-ffmpeg-ro-optout-'));
        try {
            chmodSync(dir, 0o555);
            const result = spawnSync('sh', [SCRIPT], {
                env: {
                    ...process.env,
                    FFMPEG_AUTO_DOWNLOAD: 'false',
                    FFMPEG_CACHE_DIR: dir,
                    FFMPEG_PATH: join(dir, 'ffmpeg'),
                    FFPROBE_PATH: join(dir, 'ffprobe'),
                },
                timeout: TEST_TIMEOUT_MS,
                encoding: 'utf8',
            });
            expect(result.signal).toBeNull();
            expect(result.status).toBe(0);
            expect(result.stdout).toMatch(/skipping auto-download/i);
        } finally {
            chmodSync(dir, 0o755);
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('fetch-ffmpeg.sh: shared SELinux cache', () => {
    it('extracts inside the cache so published files inherit its shared label', () => {
        const root = mkdtempSync(join(tmpdir(), 'fetch-ffmpeg-label-'));
        const cache = join(root, 'cache');
        const bin = join(root, 'bin');
        const payload = join(root, 'payload');
        const archive = join(root, 'fixture.tar.xz');
        const extractionLog = join(root, 'extraction-dir');
        const script = (path: string, body: string): void => {
            writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        };
        try {
            for (const dir of [cache, bin, payload, join(root, 'node_modules/.bin')])
                mkdirSync(dir, { recursive: true });
            const stale = ['.fetch-abandoned', '.stage-abandoned'];
            const fresh = ['.fetch-active', '.stage-active', 'jellyfin-ffmpeg-old'];
            const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
            for (const name of [...stale, ...fresh]) {
                mkdirSync(join(cache, name));
                writeFileSync(join(cache, name, 'payload'), 'keep unless stale staging');
                if (stale.includes(name) || name === 'jellyfin-ffmpeg-old')
                    utimesSync(join(cache, name), old, old);
            }
            script(join(payload, 'ffmpeg'), 'exit 0');
            script(join(payload, 'ffprobe'), 'exit 0');
            expect(spawnSync('tar', ['-cJf', archive, '-C', payload, '.']).status).toBe(0);
            const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
            script(join(root, 'node_modules/.bin/tsx'), `printf 'fixture-url\\t${digest}\\n'`);
            script(
                join(bin, 'curl'),
                'while [ "$1" != "-o" ]; do shift; done; cp "$FIXTURE_ARCHIVE" "$2"',
            );
            script(join(bin, 'tar'), 'printf "%s\\n" "$4" > "$EXTRACTION_LOG"; exec /bin/tar "$@"');
            const result = spawnSync('sh', [SCRIPT], {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    FFMPEG_AUTO_DOWNLOAD: 'true',
                    FFMPEG_CACHE_DIR: cache,
                    FFMPEG_PATH: join(cache, 'ffmpeg'),
                    FFPROBE_PATH: join(cache, 'ffprobe'),
                    FIXTURE_ARCHIVE: archive,
                    EXTRACTION_LOG: extractionLog,
                },
                timeout: TEST_TIMEOUT_MS,
                encoding: 'utf8',
            });
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain('ffmpeg ready');
            for (const name of stale) expect(existsSync(join(cache, name)), name).toBe(false);
            for (const name of fresh) expect(existsSync(join(cache, name)), name).toBe(true);
            // Moving from /tmp preserves a container-private MCS label even
            // when /config was mounted :z. Create the inodes on the cache FS.
            expect(readFileSync(extractionLog, 'utf8').trim().startsWith(`${cache}/`)).toBe(true);
            expect(spawnSync(join(cache, 'ffmpeg'), ['-version']).status).toBe(0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
