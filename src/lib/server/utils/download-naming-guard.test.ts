// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: a downloaded file is always renamed by us. On-disk names (release groups, scene
// tags) must never reach a Content-Disposition, so no server code may build one from
// basename(<path>).

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
}

describe('download file naming', () => {
    it('no non-test file under src/lib/server passes an on-disk basename to attachmentDisposition', () => {
        const root = join(__dirname, '..');
        const offenders = walk(root).filter((f) => {
            const src = readFileSync(f, 'utf8');
            return /attachmentDisposition\(\s*(?:path\.|nodePath\.)?(?:basename|parse)\(/.test(src);
        });
        expect(offenders).toEqual([]);
    });

    it('the guard pattern catches the pattern it forbids', () => {
        const re = /attachmentDisposition\(\s*(?:path\.|nodePath\.)?(?:basename|parse)\(/;
        expect(re.test('attachmentDisposition(basename(containerPath))')).toBe(true);
        expect(re.test('attachmentDisposition(filename)')).toBe(false);
    });
});
