// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { rm } from 'node:fs/promises';
import type { Plugin } from 'vite';

/**
 * Removes the per-run module dump Vitest writes to `os.tmpdir()` and never deletes.
 *
 * Vitest 5 (checked through 5.0.2) gives every `Vitest` instance a
 * `_tmpDir = join(tmpdir(), nanoid())`. The forks pool copies each transformed
 * module there (`<dir>/ssr/<sha1>`, `<dir>/client/<sha1>`) so it can hand workers a
 * path instead of `process.send(bigBuffer)`. A single-project config reuses that
 * core fetcher, so the files land in `_tmpDir` — and only the per-project
 * `tmpDir` is removed on close. Result: ~226 MB left in /tmp per unit-suite run;
 * 153 GB (1,323 dirs) filled the self-hosted runner's disk on 2026-09-30 and
 * failed the Docker deploys with ENOSPC.
 *
 * `_tmpDir` is internal, so this reads it defensively and does nothing if a
 * Vitest upgrade renames it. A run killed before close still leaks its dir; the
 * docker-publish cleanup step reaps those on the CI host.
 */
export function cleanVitestTmpDir(): Plugin {
    return {
        name: 'lumastra:clean-vitest-tmpdir',
        configureVitest({ vitest }) {
            const dir = (vitest as unknown as { _tmpDir?: unknown })._tmpDir;
            if (typeof dir !== 'string' || dir === '') return;
            vitest.onClose(() => rm(dir, { recursive: true, force: true }));
        },
    };
}
