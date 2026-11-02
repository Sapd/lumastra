// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/api/v1/*` is the bearer-token surface: an admin's browser session (forward
 * auth / cookie) is answered with 401 "Bearer token required". Admin UI must
 * call the internal `/api/*` mount of the same def instead. This bit three
 * times — task Run now (dc8fef4ba), and queue pause/resume in MetroLine and
 * /admin/fix/slow — each surfacing only as a generic "Failed to …" toast.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = ['src/lib/components/admin', 'src/routes/admin'];
const CLIENT_CALL = /\b(?:apiGet|apiPost|apiPut|apiPatch|apiDelete|fetch)\s*\(\s*[`'"]\/api\/v1\//;

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sourceFiles(path);
        return /\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
    });
}

describe('admin UI API surface', () => {
    it('never calls the bearer-only /api/v1 surface from the browser', () => {
        const offenders = ROOTS.flatMap(sourceFiles)
            .filter((file) => !file.includes('.server.'))
            .flatMap((file) =>
                readFileSync(file, 'utf8')
                    .split('\n')
                    .map((line, index) => ({ line, index }))
                    .filter(({ line }, index, lines) =>
                        // The URL is often on the line after the call's `(`.
                        CLIENT_CALL.test(
                            `${line}${lines[index + 1]?.line ?? ''}`.replace(/\s+/g, ' '),
                        ),
                    )
                    .map(({ index }) => `${relative(process.cwd(), file)}:${index + 1}`),
            );
        expect(offenders).toEqual([]);
    });
});
