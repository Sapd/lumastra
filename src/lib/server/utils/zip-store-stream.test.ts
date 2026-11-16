// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
    predictZipSize,
    zipStoreStream,
    zipStoreReadable,
    crc32Update,
    type ZipEntrySource,
} from './zip-store-stream';

function bufEntry(name: string, data: Buffer, mtime?: Date): ZipEntrySource {
    return { name, size: data.length, mtime, openSource: async () => Readable.from([data]) };
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const c of gen) parts.push(Buffer.from(c));
    return Buffer.concat(parts);
}

const SMALL: ZipEntrySource[] = [
    bufEntry('Show (2004)/Season 01/Café – S01E01.mkv', Buffer.from('hello world')),
    bufEntry('Show (2004)/Season 01/S01E02.mkv', Buffer.alloc(200_000, 7)),
    bufEntry('Show (2004)/Season 02/empty.mkv', Buffer.alloc(0)),
];

describe('predictZipSize', () => {
    it('equals the bytes produced for small inputs', async () => {
        const out = await collect(zipStoreStream(SMALL));
        expect(out.length).toBe(predictZipSize(SMALL.map((e) => ({ name: e.name, size: e.size }))));
    });

    it('equals the bytes produced for an empty archive', async () => {
        const out = await collect(zipStoreStream([]));
        expect(out.length).toBe(predictZipSize([]));
        expect(out.length).toBe(22);
    });

    it('is deterministic for identical input', async () => {
        const a = await collect(zipStoreStream(SMALL));
        const b = await collect(zipStoreStream(SMALL));
        expect(a.equals(b)).toBe(true);
    });

    it('equals the bytes produced with forced Zip64 records', async () => {
        const out = await collect(zipStoreStream(SMALL, { forceZip64: true }));
        expect(out.length).toBe(
            predictZipSize(
                SMALL.map((e) => ({ name: e.name, size: e.size })),
                { forceZip64: true },
            ),
        );
    });
});

describe('zipStoreStream round trip', () => {
    const haveUnzip = spawnSync('unzip', ['-v']).status === 0;
    const havePython = spawnSync('python3', ['-V']).status === 0;

    function withArchive(bytes: Buffer, fn: (path: string) => void): void {
        const dir = mkdtempSync(join(tmpdir(), 'zip-store-'));
        try {
            const p = join(dir, 'a.zip');
            writeFileSync(p, bytes);
            fn(p);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    const PY = `
import zipfile, sys, json, zlib
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
out = []
for i in z.infolist():
    d = z.read(i.filename)
    out.append([i.filename, len(d), i.compress_type, zlib.crc32(d) == i.CRC, i.flag_bits & 0x800 != 0])
print(json.dumps(out))
`;

    for (const forceZip64 of [false, true]) {
        it.skipIf(!havePython)(`python zipfile reads it (forceZip64=${forceZip64})`, async () => {
            const bytes = await collect(zipStoreStream(SMALL, { forceZip64 }));
            withArchive(bytes, (p) => {
                const r = spawnSync('python3', ['-I', '-c', PY, p], { encoding: 'utf8' });
                expect(r.stderr).toBe('');
                expect(r.status).toBe(0);
                expect(JSON.parse(r.stdout)).toEqual([
                    ['Show (2004)/Season 01/Café – S01E01.mkv', 11, 0, true, true],
                    ['Show (2004)/Season 01/S01E02.mkv', 200_000, 0, true, true],
                    ['Show (2004)/Season 02/empty.mkv', 0, 0, true, true],
                ]);
            });
        });

        it.skipIf(!haveUnzip)(`unzip -t accepts it (forceZip64=${forceZip64})`, async () => {
            const bytes = await collect(zipStoreStream(SMALL, { forceZip64 }));
            withArchive(bytes, (p) => {
                const r = spawnSync('unzip', ['-t', p], { encoding: 'utf8' });
                expect(r.status).toBe(0);
                expect(r.stdout).toContain('No errors detected');
            });
        });
    }

    it('writes correct CRC-32 and UTF-8 flag in the central directory', async () => {
        const data = Buffer.from('The quick brown fox jumps over the lazy dog');
        const out = await collect(zipStoreStream([bufEntry('é.txt', data)]));
        // central directory header signature
        const cd = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        expect(cd).toBeGreaterThan(0);
        expect(out.readUInt32LE(cd + 16)).toBe(0x414fa339);
        expect(out.readUInt16LE(cd + 8) & 0x0800).toBe(0x0800);
        expect(out.readUInt16LE(cd + 8) & 0x0008).toBe(0x0008);
        expect(out.readUInt16LE(cd + 10)).toBe(0); // STORE
    });

    it('crc32Update is incremental', () => {
        const a = Buffer.from('The quick brown fox ');
        const b = Buffer.from('jumps over the lazy dog');
        expect(crc32Update(crc32Update(0, a), b)).toBe(0x414fa339);
    });
});

describe('zipStoreStream errors', () => {
    it('aborts when the file is longer than announced', async () => {
        const e: ZipEntrySource = {
            name: 'a.bin',
            size: 5,
            openSource: async () => Readable.from([Buffer.alloc(10)]),
        };
        await expect(collect(zipStoreStream([e]))).rejects.toThrow(/size/i);
    });

    it('aborts when the file is shorter than announced', async () => {
        const e: ZipEntrySource = {
            name: 'a.bin',
            size: 50,
            openSource: async () => Readable.from([Buffer.alloc(10)]),
        };
        await expect(collect(zipStoreStream([e]))).rejects.toThrow(/size/i);
    });

    it('rejects unsafe entry names', async () => {
        for (const name of ['', '/abs.txt', '../x.txt', 'a/../x.txt', 'a\\b.txt', 'a\0b']) {
            await expect(
                collect(zipStoreStream([bufEntry(name, Buffer.from('x'))])),
            ).rejects.toThrow(/name/i);
        }
    });

    it('destroys the open source when the consumer stops early', async () => {
        let destroyed = false;
        const src = new Readable({
            read() {
                this.push(Buffer.alloc(1024));
            },
            destroy(err, cb) {
                destroyed = true;
                cb(err);
            },
        });
        const gen = zipStoreStream([
            { name: 'a.bin', size: 1_000_000, openSource: async () => src },
        ]);
        await gen.next();
        await gen.next();
        await gen.return(undefined);
        expect(destroyed).toBe(true);
    });
});

/** A readable that yields `size` zero bytes lazily (1 MiB blocks, one shared buffer). */
function zeros(size: number): Readable {
    const block = Buffer.alloc(1 << 20);
    let left = size;
    return new Readable({
        highWaterMark: 1 << 20,
        read() {
            if (left <= 0) {
                this.push(null);
                return;
            }
            const n = Math.min(left, block.length);
            left -= n;
            this.push(n === block.length ? block : block.subarray(0, n));
        },
    });
}

describe('cancellation during a stalled read', () => {
    function stalled(onDestroy: () => void): Readable {
        return new Readable({
            read() {
                // never pushes: the read stays pending
            },
            destroy(err, cb) {
                onDestroy();
                cb(err);
            },
        });
    }

    it('aborting the signal destroys the active source and rejects the pending next()', async () => {
        let destroyed = false;
        const ac = new AbortController();
        const gen = zipStoreStream(
            [
                {
                    name: 'a.bin',
                    size: 10,
                    openSource: async () => stalled(() => (destroyed = true)),
                },
            ],
            { signal: ac.signal },
        );
        await gen.next(); // local header
        const pending = gen.next(); // stalled inside the file read
        await new Promise((r) => setTimeout(r, 10));
        ac.abort();
        await expect(pending).rejects.toThrow();
        expect(destroyed).toBe(true);
    });

    it('destroying the Readable reaches the stalled source and closes', async () => {
        let destroyed = false;
        const r = zipStoreReadable([
            { name: 'a.bin', size: 10, openSource: async () => stalled(() => (destroyed = true)) },
        ]);
        r.on('error', () => {});
        await new Promise<void>((resolve) => r.once('data', () => resolve())); // the header
        await new Promise((res) => setTimeout(res, 10)); // generator is now in the stalled read
        const closed = new Promise<void>((resolve) => r.once('close', () => resolve()));
        r.destroy();
        await Promise.race([
            closed,
            new Promise((_, rej) => setTimeout(() => rej(new Error('did not close')), 2000)),
        ]);
        expect(destroyed).toBe(true);
    });
});

describe('predictZipSize limits', () => {
    it('rejects a total beyond Number.MAX_SAFE_INTEGER, accepts one just below', () => {
        const max = Number.MAX_SAFE_INTEGER;
        expect(() =>
            predictZipSize([
                { name: 'a', size: max },
                { name: 'b', size: 1 },
            ]),
        ).toThrow(RangeError);
        // one entry whose overhead pushes it over
        expect(() => predictZipSize([{ name: 'a', size: max }])).toThrow(RangeError);
        const overhead = predictZipSize([{ name: 'a', size: 0 }], {});
        expect(predictZipSize([{ name: 'a', size: max - 1000 }])).toBeLessThanOrEqual(max);
        expect(overhead).toBeGreaterThan(0);
    });

    it('rejects an unsafe size', () => {
        expect(() => predictZipSize([{ name: 'a', size: Number.MAX_SAFE_INTEGER + 2 }])).toThrow();
        expect(() => predictZipSize([{ name: 'a', size: -1 }])).toThrow();
    });
});

describe('Zip64', () => {
    it('writes Zip64 records for an entry over 4 GiB and a following offset past 4 GiB', async () => {
        const big = 0xffffffff + 10; // > 4 GiB
        const entries: ZipEntrySource[] = [
            { name: 'big.bin', size: big, openSource: async () => zeros(big) },
            bufEntry('after.txt', Buffer.from('tail')),
        ];
        const predicted = predictZipSize(entries.map((e) => ({ name: e.name, size: e.size })));

        let total = 0;
        let head = Buffer.alloc(0);
        let tail = Buffer.alloc(0);
        for await (const chunk of zipStoreStream(entries)) {
            const b = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            if (total < 4096) head = Buffer.concat([head, b.subarray(0, 4096 - total)]);
            total += b.length;
            tail = Buffer.concat([tail, b.subarray(Math.max(0, b.length - 8192))]);
            if (tail.length > 8192) tail = tail.subarray(tail.length - 8192);
        }
        expect(total).toBe(predicted);

        // local header of the big entry: version 45, sizes 0xFFFFFFFF, Zip64 extra present
        expect(head.readUInt32LE(0)).toBe(0x04034b50);
        expect(head.readUInt16LE(4)).toBe(45);
        expect(head.readUInt32LE(18)).toBe(0xffffffff);
        expect(head.readUInt32LE(22)).toBe(0xffffffff);
        const nameLen = head.readUInt16LE(26);
        const extraLen = head.readUInt16LE(28);
        expect(extraLen).toBe(20);
        const x = 30 + nameLen;
        expect(head.readUInt16LE(x)).toBe(0x0001);
        expect(Number(head.readBigUInt64LE(x + 4))).toBe(big);
        expect(Number(head.readBigUInt64LE(x + 12))).toBe(big);

        // tail: Zip64 EOCD, locator, classic EOCD
        const eocd = tail.length - 22;
        expect(tail.readUInt32LE(eocd)).toBe(0x06054b50);
        expect(tail.readUInt16LE(eocd + 10)).toBe(0xffff); // real count is in the Zip64 record
        expect(tail.readUInt32LE(eocd + 16)).toBe(0xffffffff); // cd offset in Zip64 record
        const loc = eocd - 20;
        expect(tail.readUInt32LE(loc)).toBe(0x07064b50);
        const z64 = loc - 56;
        expect(tail.readUInt32LE(z64)).toBe(0x06064b50);
        expect(Number(tail.readBigUInt64LE(z64 + 24))).toBe(2); // entries total
        const cdOffset = Number(tail.readBigUInt64LE(z64 + 48));
        const cdSize = Number(tail.readBigUInt64LE(z64 + 40));
        expect(cdOffset).toBeGreaterThan(0xffffffff);
        expect(cdOffset + cdSize).toBe(total - 56 - 20 - 22);
        expect(Number(tail.readBigUInt64LE(loc + 8))).toBe(total - 22 - 20 - 56);

        // central directory of the second entry carries the Zip64 offset (> 4 GiB)
        const cdStartInTail = tail.length - 22 - 20 - 56 - cdSize;
        const cd = tail.subarray(cdStartInTail);
        const first = cd.readUInt16LE(28) + cd.readUInt16LE(30) + cd.readUInt16LE(32) + 46;
        expect(cd.readUInt32LE(0)).toBe(0x02014b50);
        expect(cd.readUInt32LE(20)).toBe(0xffffffff); // big entry: sizes in extra
        expect(cd.readUInt32LE(42)).toBe(0); // its offset fits
        expect(cd.readUInt32LE(first)).toBe(0x02014b50);
        expect(cd.readUInt32LE(first + 42)).toBe(0xffffffff); // second entry: offset in extra
    }, 120_000);
});
