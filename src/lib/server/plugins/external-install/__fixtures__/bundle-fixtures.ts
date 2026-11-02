// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared deterministic ustar / gzip builders + malicious-archive builders for
// the external-plugin bundle test suites. The `header`/`buildTar` writer here is
// the canonical plain-ustar shape the host extractor and the signer both accept.

import * as zlib from 'node:zlib';

const BLOCK = 512;

export interface TarEntry {
    name: string;
    content: string;
    typeflag?: string;
}

/** Build ONE canonical ustar 512-byte header block for a regular file. */
export function header(name: string, size: number, typeflag = '0'): Buffer {
    const b = Buffer.alloc(BLOCK);
    b.write(name, 0, 'utf8'); // name field (offset 0, 100)
    b.write('0000644', 100, 'ascii'); // mode
    b.write('0000000', 108, 'ascii'); // uid
    b.write('0000000', 116, 'ascii'); // gid
    b.write(size.toString(8).padStart(11, '0'), 124, 'ascii'); // size (11 octal + NUL)
    b.write('00000000000', 136, 'ascii'); // mtime = 0
    b.write(typeflag, 156, 'ascii'); // typeflag
    b.write('ustar\0', 257, 'binary'); // magic
    b.write('00', 263, 'ascii'); // version
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return b;
}

/** Concatenate file entries into a canonical ustar archive + 2 zero blocks. */
export function buildTar(entries: TarEntry[]): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.content, 'utf8');
        parts.push(header(e.name, data.length, e.typeflag ?? '0'));
        const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
        data.copy(padded);
        parts.push(padded);
    }
    parts.push(Buffer.alloc(1024)); // two zero blocks
    return Buffer.concat(parts);
}

/** Gzip a canonical ustar archive (compression detected by magic bytes at install). */
export function buildGzipTar(entries: TarEntry[]): Buffer {
    return zlib.gzipSync(buildTar(entries));
}

// --- Malicious builders (each is rejected pre-write by the host extractor) ---

/** A `..` traversal entry → zip-slip; rejected by isSafeRelativePath. */
export function tarWithZipSlip(): Buffer {
    return buildTar([{ name: '../evil', content: 'x' }]);
}

/** A typeflag-'2' symlink entry → rejected as an unsupported tar entry type. */
export function tarWithSymlink(): Buffer {
    return buildTar([{ name: 'link', content: '', typeflag: '2' }]);
}

/** A typeflag-'5' directory entry → rejected (archive is regular-files-only). */
export function tarWithDirEntry(): Buffer {
    return buildTar([{ name: 'd/', content: '', typeflag: '5' }]);
}

// --- A minimal 2-file ESM task plugin (entry imports the sibling schema) ---

export const TASK_BUNDLE_ENTRY = (name: string): string =>
    `import { schema } from './schema.js';\n` +
    `export default { id: '${name}', name: 'Sample Plugin', version: '1.0.0', ` +
    `processingVersion: 1, resourceClass: 'maintenance', capabilities: {}, ` +
    `identityFor: () => 'global', inputSchema: schema, ` +
    `execute: async () => ({ ok: true }) };\n`;
// Duck-typed, because `defineTask` checks for .parse/.safeParse rather than
// for a zod instance — and a bundle sibling must not pull zod into the fixture.
export const TASK_BUNDLE_SIB = `export const schema = { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) };\n`;
