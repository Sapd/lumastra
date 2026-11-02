// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { extractTarball, computeTreeDigest, inflateIfGzip, type ArchiveLimits } from './archive.js';

const LIMITS: ArchiveLimits = {
    maxTotalBytes: 1024 * 1024,
    maxEntries: 64,
    maxFileBytes: 512 * 1024,
};

/** Build ONE canonical ustar 512-byte header block for a regular file. */
function header(name: string, size: number, typeflag = '0'): Buffer {
    const b = Buffer.alloc(512);
    b.write(name, 0, 'utf8'); // name field (offset 0, 100)
    b.write('0000644', 100, 'ascii'); // mode
    b.write('0000000', 108, 'ascii'); // uid
    b.write('0000000', 116, 'ascii'); // gid
    b.write(size.toString(8).padStart(11, '0'), 124, 'ascii'); // size (11 octal + NUL)
    b.write('00000000000', 136, 'ascii'); // mtime = 0
    b.write(typeflag, 156, 'ascii'); // typeflag
    b.write('ustar\0', 257, 'binary'); // magic
    b.write('00', 263, 'ascii'); // version
    // checksum: fill field with spaces, sum, then write octal
    b.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += b[i];
    b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return b;
}

/** Concatenate file entries (name→content) into a ustar archive + 2 zero blocks. */
function buildTar(entries: Array<{ name: string; content: string; typeflag?: string }>): Buffer {
    const parts: Buffer[] = [];
    for (const e of entries) {
        const data = Buffer.from(e.content, 'utf8');
        parts.push(header(e.name, data.length, e.typeflag ?? '0'));
        const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
        data.copy(padded);
        parts.push(padded);
    }
    parts.push(Buffer.alloc(1024)); // two zero blocks
    return Buffer.concat(parts);
}

let dir: string;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractTarball happy path', () => {
    it('extracts files, materialises implicit dirs, returns deterministic digest', () => {
        const tar = buildTar([
            { name: 'index.js', content: 'export default {};' },
            { name: 'lib/util.js', content: 'export const x = 1;' },
        ]);
        const res = extractTarball(tar, dir, LIMITS);
        expect(fs.readFileSync(path.join(dir, 'index.js'), 'utf8')).toBe('export default {};');
        expect(fs.readFileSync(path.join(dir, 'lib/util.js'), 'utf8')).toBe('export const x = 1;');
        expect(res.files.map((f) => f.path)).toEqual(['index.js', 'lib/util.js']);
        expect(res.treeDigest).toMatch(/^[a-f0-9]{64}$/);
        // Re-verify walk over the extracted dir reproduces the same digest.
        expect(computeTreeDigest(dir, LIMITS).treeDigest).toBe(res.treeDigest);
    });

    it('gzip round-trips identically', () => {
        const tar = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        const gz = zlib.gzipSync(tar);
        const raw = inflateIfGzip(gz, LIMITS);
        const res = extractTarball(raw, dir, LIMITS);
        expect(res.files).toHaveLength(1);
    });
});

function assertNoFiles(d: string): void {
    // Only the mkdtemp dir itself may exist; no plugin files written.
    const walk = (p: string): string[] =>
        fs
            .readdirSync(p, { withFileTypes: true })
            .flatMap((e) =>
                e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)],
            );
    expect(walk(d)).toEqual([]);
}

describe('extractTarball rejects zip-slip', () => {
    it.each([['../evil'], ['a/../../b'], ['/etc/passwd']])('rejects %s', (name) => {
        const tar = buildTar([{ name, content: 'x' }]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow();
        assertNoFiles(dir);
    });
    it('rejects escape via prefix+name join', () => {
        // craft a header whose prefix joins to escape
        const b = header('evil', 1);
        b.write('..', 345, 'ascii'); // prefix = ".." → "../evil"
        // recompute checksum after mutating prefix
        b.fill(0x20, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += b[i];
        b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
        const tar = Buffer.concat([b, Buffer.alloc(512), Buffer.alloc(1024)]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsafe path|escapes/);
        assertNoFiles(dir);
    });
});

describe('extractTarball rejects non-regular typeflags', () => {
    it.each([['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['x'], ['g'], ['L'], ['K']])(
        'rejects typeflag %s',
        (tf) => {
            const tar = buildTar([{ name: 'x', content: '', typeflag: tf }]);
            expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsupported tar entry type/);
            assertNoFiles(dir);
        },
    );
    it("rejects a '5' directory entry with nonzero declared size without desync", () => {
        const tar = buildTar([{ name: 'dir/', content: 'AAAA', typeflag: '5' }]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsupported tar entry type/);
        assertNoFiles(dir);
    });
    it('rejects dir// (double trailing slash) even as a file entry', () => {
        const tar = buildTar([{ name: 'dir//', content: '' }]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsafe path/);
        assertNoFiles(dir);
    });
    it('materialises a/ implicitly from a/b.js (no dir entry needed)', () => {
        const tar = buildTar([{ name: 'a/b.js', content: 'x' }]);
        const res = extractTarball(tar, dir, LIMITS);
        expect(res.files.map((f) => f.path)).toEqual(['a/b.js']);
        expect(fs.statSync(path.join(dir, 'a')).isDirectory()).toBe(true);
    });
});

describe('extractTarball file/dir collision (ENOTDIR)', () => {
    it('a then a/b fails closed', () => {
        const tar = buildTar([
            { name: 'a', content: 'file' },
            { name: 'a/b', content: 'nested' },
        ]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow();
    });
});

describe('extractTarball bomb guards', () => {
    it('rejects > maxEntries', () => {
        const entries = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.js`, content: 'x' }));
        expect(() => extractTarball(buildTar(entries), dir, { ...LIMITS, maxEntries: 2 })).toThrow(
            /too many entries/,
        );
    });
    it('rejects a single file > maxFileBytes', () => {
        const tar = buildTar([{ name: 'big.js', content: 'x'.repeat(200) }]);
        expect(() => extractTarball(tar, dir, { ...LIMITS, maxFileBytes: 100 })).toThrow(
            /exceeds max size/,
        );
    });
    it('rejects cumulative > maxTotalBytes', () => {
        const tar = buildTar([
            { name: 'a.js', content: 'x'.repeat(80) },
            { name: 'b.js', content: 'x'.repeat(80) },
        ]);
        expect(() => extractTarball(tar, dir, { ...LIMITS, maxTotalBytes: 100 })).toThrow(
            /total extracted/,
        );
    });
    it('inflateIfGzip throws on a gzip that inflates past the allowance', () => {
        const tar = buildTar([{ name: 'a.js', content: 'x'.repeat(50_000) }]);
        const gz = zlib.gzipSync(tar);
        expect(() =>
            inflateIfGzip(gz, { maxTotalBytes: 1000, maxEntries: 4, maxFileBytes: 1000 }),
        ).toThrow();
    });
});

describe('extractTarball corruption + numeric strictness', () => {
    it('rejects bad magic', () => {
        const b = header('x', 1);
        b.write('nomag', 257, 'binary');
        const tar = Buffer.concat([b, Buffer.alloc(512), Buffer.alloc(1024)]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/not-ustar/);
    });
    it('rejects bad header checksum', () => {
        const b = header('x', 1);
        b.write('000000', 148, 'ascii'); // corrupt stored checksum (valid octal, wrong value)
        const tar = Buffer.concat([b, Buffer.alloc(512), Buffer.alloc(1024)]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/checksum/);
    });
    it('rejects declared size overrunning the buffer', () => {
        const b = header('x', 4096); // claims 4096 but no data blocks follow
        const tar = Buffer.concat([b, Buffer.alloc(1024)]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/exceeds archive length/);
    });
    it('rejects base-256 (high-bit) size field', () => {
        const b = header('x', 1);
        b[124] = 0x80; // high bit set in size field
        // fix checksum so we reach the numeric parse
        b.fill(0x20, 148, 156);
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += b[i];
        b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
        const tar = Buffer.concat([b, Buffer.alloc(512), Buffer.alloc(1024)]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsupported numeric encoding/);
    });
});

describe('extractTarball missing end-of-archive blocks', () => {
    it('rejects a truncated archive (trailing 1024-byte terminator sliced off)', () => {
        // A well-formed single-entry tar ends on a block boundary; drop the two
        // zero blocks so the stream runs out before the end marker is seen. Even
        // though the header+data parse cleanly, the loop MUST reject rather than
        // treat the block-aligned prefix as a valid smaller archive (§8.1).
        const full = buildTar([{ name: 'index.js', content: 'export default {};' }]);
        const truncated = full.subarray(0, full.length - 1024);
        expect(() => extractTarball(truncated, dir, LIMITS)).toThrow(
            /missing end-of-archive blocks/,
        );
    });
});

describe('extractTarball duplicate + case-fold', () => {
    it('rejects an exact duplicate path', () => {
        const tar = buildTar([
            { name: 'a.js', content: '1' },
            { name: 'a.js', content: '2' },
        ]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/duplicate path/);
    });
    it('rejects a case-fold collision', () => {
        const tar = buildTar([
            { name: 'A.js', content: '1' },
            { name: 'a.js', content: '2' },
        ]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/duplicate path/);
    });
});

describe('listing-line injection', () => {
    it('rejects a filename containing a newline at extraction', () => {
        const tar = buildTar([{ name: 'p1\nHASH  9  p2', content: 'x' }]);
        expect(() => extractTarball(tar, dir, LIMITS)).toThrow(/unsafe path/);
        assertNoFiles(dir);
    });
});

describe('computeTreeDigest tamper detection', () => {
    it('changes when a byte is modified / a file added / removed', () => {
        const tar = buildTar([
            { name: 'index.js', content: 'a' },
            { name: 'lib/x.js', content: 'b' },
        ]);
        const base = extractTarball(tar, dir, LIMITS).treeDigest;
        fs.writeFileSync(path.join(dir, 'index.js'), 'MODIFIED');
        expect(computeTreeDigest(dir, LIMITS).treeDigest).not.toBe(base);
        fs.writeFileSync(path.join(dir, 'index.js'), 'a'); // restore
        fs.writeFileSync(path.join(dir, 'added.js'), 'c');
        expect(computeTreeDigest(dir, LIMITS).treeDigest).not.toBe(base);
        fs.rmSync(path.join(dir, 'added.js'));
        fs.rmSync(path.join(dir, 'lib/x.js'));
        expect(computeTreeDigest(dir, LIMITS).treeDigest).not.toBe(base);
    });

    it('refuses a symlink planted in the tree (no dereference)', () => {
        const tar = buildTar([{ name: 'index.js', content: 'a' }]);
        extractTarball(tar, dir, LIMITS);
        fs.symlinkSync('/etc/passwd', path.join(dir, 'evil'));
        expect(() => computeTreeDigest(dir, LIMITS)).toThrow(/non-regular entry/);
    });

    it('refuses a symlink-directory loop PROMPTLY (no hang)', () => {
        const tar = buildTar([{ name: 'index.js', content: 'a' }]);
        extractTarball(tar, dir, LIMITS);
        fs.mkdirSync(path.join(dir, 'sub'));
        fs.symlinkSync(dir, path.join(dir, 'sub', 'loop')); // cycle
        const start = Date.now();
        expect(() => computeTreeDigest(dir, LIMITS)).toThrow(/non-regular entry/);
        expect(Date.now() - start).toBeLessThan(2000);
    });

    it('refuses an on-disk filename with a control byte', () => {
        // Simulate a walked path that fails isSafeRelativePath by using a raw byte.
        const tar = buildTar([{ name: 'index.js', content: 'a' }]);
        extractTarball(tar, dir, LIMITS);
        const bad = path.join(dir, 'bad\nname.js');
        fs.writeFileSync(bad, 'x');
        expect(() => computeTreeDigest(dir, LIMITS)).toThrow(/unsafe path/);
    });
});
