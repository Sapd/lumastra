// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * zip-store-stream.ts: a streaming, dependency-free ZIP writer that STOREs
 * (method 0, no compression) and knows the exact archive size up front.
 *
 * Why STORE: the payload is video, which does not compress, and STORE lets the
 * response carry an exact Content-Length (so a browser shows real progress and
 * can tell a truncated download from a finished one) without buffering anything.
 *
 * Layout per entry: local header, file bytes, data descriptor (CRC-32 is only
 * known after the bytes were streamed, hence general-purpose flag bit 3). Then
 * the central directory, and, when a count, size or offset does not fit the
 * classic fields, the Zip64 end-of-central-directory record and locator before
 * the classic EOCD. Names are UTF-8 (flag bit 11).
 *
 * Zip64: an entry of 4 GiB or more gets a Zip64 extra field in its local and
 * central header and a 24-byte data descriptor; an entry whose local header
 * offset is 4 GiB or more gets the offset in the central directory's Zip64
 * extra. Both are read by macOS Archive Utility, Windows Explorer, unzip and
 * Python's zipfile.
 *
 * Safety: the size of every entry is announced before streaming (it is in the
 * Content-Length). If a file turns out to have a different length, the stream
 * errors instead of emitting a central directory that would describe other
 * bytes than the ones sent.
 */

import { crc32 as zlibCrc32 } from 'node:zlib';
import { Readable } from 'node:stream';

export interface ZipEntrySource {
    /** Forward-slash path inside the archive, no leading slash, no `..` segment. */
    name: string;
    /** Exact byte count `open()` will deliver. */
    size: number;
    /** Modification time for the DOS timestamp; a fixed constant when omitted. */
    mtime?: Date | number;
    /** Open the file's bytes; named so it is not mistaken for a raw fs open. */
    openSource(): Promise<Readable>;
}

export interface ZipOptions {
    /** Write Zip64 records for every entry and the Zip64 EOCD even when not needed (tests). */
    forceZip64?: boolean;
    /**
     * Aborting destroys the file being read right away, even while a read is stalled (the
     * generator cannot see `return()` until its pending read settles), and ends the stream with
     * an error.
     */
    signal?: AbortSignal;
}

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

/** Bit 3: sizes/CRC follow the data. Bit 11: file name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;

/** 1980-01-01 00:00:00 */
const DOS_EPOCH = { time: 0, date: (0 << 9) | (1 << 5) | 1 };

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32Table(prev: number, data: Uint8Array): number {
    let c = ~prev >>> 0;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff]! ^ (c >>> 8);
    return ~c >>> 0;
}

/** Continue a CRC-32 (start with 0). Uses node:zlib's native `crc32` (Node 22.2+), else a table. */
export function crc32Update(prev: number, data: Uint8Array): number {
    return typeof zlibCrc32 === 'function' ? zlibCrc32(data, prev) : crc32Table(prev, data);
}

// ---------------------------------------------------------------------------
// Layout (shared by the writer and predictZipSize)
// ---------------------------------------------------------------------------

function dosDateTime(mtime: Date | number | undefined): { time: number; date: number } {
    if (mtime === undefined) return DOS_EPOCH;
    const d = typeof mtime === 'number' ? new Date(mtime) : mtime;
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return DOS_EPOCH;
    let year = d.getUTCFullYear();
    if (year < 1980) return DOS_EPOCH;
    if (year > 2107) year = 2107;
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
        date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

// eslint-disable-next-line no-control-regex -- rejecting NUL / control characters is the point
const BAD_NAME_CHARS = /[\x00-\x1F\\]/;

function checkName(name: string): Buffer {
    const bytes = Buffer.from(name, 'utf8');
    if (
        name === '' ||
        name.startsWith('/') ||
        BAD_NAME_CHARS.test(name) ||
        name.split('/').some((seg) => seg === '..' || seg === '') ||
        bytes.length > U16_MAX
    ) {
        throw new Error(`Unsafe or invalid ZIP entry name: ${JSON.stringify(name.slice(0, 80))}`);
    }
    return bytes;
}

interface Planned {
    nameLen: number;
    size: number;
    /** Zip64 extra in the headers + 8-byte descriptor sizes. */
    big: boolean;
}

function plan(e: { name: string; size: number }, opts: ZipOptions): Planned {
    if (!Number.isSafeInteger(e.size) || e.size < 0) {
        throw new Error(`Invalid ZIP entry size for ${JSON.stringify(e.name.slice(0, 80))}`);
    }
    return {
        nameLen: checkName(e.name).length,
        size: e.size,
        big: opts.forceZip64 === true || e.size >= U32_MAX,
    };
}

const localHeaderLen = (p: Planned) => 30 + p.nameLen + (p.big ? 20 : 0);
const descriptorLen = (p: Planned) => (p.big ? 24 : 16);

function centralExtraLen(p: Planned, offset: number | bigint, opts: ZipOptions): number {
    const offBig = opts.forceZip64 === true || offset >= BigInt(U32_MAX);
    const fields = (p.big ? 2 : 0) + (offBig ? 1 : 0);
    return fields === 0 ? 0 : 4 + 8 * fields;
}

interface Totals {
    cdSize: number;
    cdOffset: number;
    zip64Eocd: boolean;
    total: number;
}

/** Sums use BigInt: many entries near the safe-integer limit must not round silently. */
function totals(planned: Planned[], opts: ZipOptions): Totals {
    let offset = 0n;
    let cdSize = 0n;
    for (const p of planned) {
        cdSize += BigInt(46 + p.nameLen + centralExtraLen(p, offset, opts));
        offset += BigInt(localHeaderLen(p) + descriptorLen(p)) + BigInt(p.size);
    }
    const zip64Eocd =
        opts.forceZip64 === true ||
        planned.length > U16_MAX ||
        offset >= BigInt(U32_MAX) ||
        cdSize >= BigInt(U32_MAX);
    const total = offset + cdSize + (zip64Eocd ? 56n + 20n : 0n) + 22n;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError('ZIP archive is too large to size exactly');
    }
    return {
        cdSize: Number(cdSize),
        cdOffset: Number(offset),
        zip64Eocd,
        total: Number(total),
    };
}

/**
 * Exact byte length of the archive `zipStoreStream` produces for these entries. Throws a
 * RangeError when the total would exceed Number.MAX_SAFE_INTEGER (it could not be a Content-Length).
 */
export function predictZipSize(
    entries: { name: string; size: number }[],
    opts: ZipOptions = {},
): number {
    return totals(
        entries.map((e) => plan(e, opts)),
        opts,
    ).total;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

function u64(b: Buffer, off: number, v: number): void {
    b.writeBigUInt64LE(BigInt(v), off);
}

function localHeader(name: Buffer, p: Planned, dt: { time: number; date: number }): Buffer {
    const b = Buffer.alloc(30 + name.length + (p.big ? 20 : 0));
    b.writeUInt32LE(SIG_LOCAL, 0);
    b.writeUInt16LE(p.big ? 45 : 20, 4);
    b.writeUInt16LE(FLAGS, 6);
    b.writeUInt16LE(0, 8); // STORE
    b.writeUInt16LE(dt.time, 10);
    b.writeUInt16LE(dt.date, 12);
    // CRC and sizes follow in the data descriptor
    b.writeUInt32LE(0, 14);
    b.writeUInt32LE(p.big ? U32_MAX : 0, 18);
    b.writeUInt32LE(p.big ? U32_MAX : 0, 22);
    b.writeUInt16LE(name.length, 26);
    b.writeUInt16LE(p.big ? 20 : 0, 28);
    name.copy(b, 30);
    if (p.big) {
        const x = 30 + name.length;
        b.writeUInt16LE(0x0001, x);
        b.writeUInt16LE(16, x + 2);
        u64(b, x + 4, p.size);
        u64(b, x + 12, p.size);
    }
    return b;
}

function descriptor(crc: number, p: Planned): Buffer {
    const b = Buffer.alloc(descriptorLen(p));
    b.writeUInt32LE(SIG_DESCRIPTOR, 0);
    b.writeUInt32LE(crc >>> 0, 4);
    if (p.big) {
        u64(b, 8, p.size);
        u64(b, 16, p.size);
    } else {
        b.writeUInt32LE(p.size, 8);
        b.writeUInt32LE(p.size, 12);
    }
    return b;
}

function centralHeader(
    name: Buffer,
    p: Planned,
    dt: { time: number; date: number },
    crc: number,
    offset: number,
    opts: ZipOptions,
): Buffer {
    const offBig = opts.forceZip64 === true || offset >= U32_MAX;
    const extraLen = centralExtraLen(p, offset, opts);
    const b = Buffer.alloc(46 + name.length + extraLen);
    b.writeUInt32LE(SIG_CENTRAL, 0);
    b.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, 4.5
    b.writeUInt16LE(p.big || offBig ? 45 : 20, 6);
    b.writeUInt16LE(FLAGS, 8);
    b.writeUInt16LE(0, 10);
    b.writeUInt16LE(dt.time, 12);
    b.writeUInt16LE(dt.date, 14);
    b.writeUInt32LE(crc >>> 0, 16);
    b.writeUInt32LE(p.big ? U32_MAX : p.size, 20);
    b.writeUInt32LE(p.big ? U32_MAX : p.size, 24);
    b.writeUInt16LE(name.length, 28);
    b.writeUInt16LE(extraLen, 30);
    b.writeUInt16LE(0, 32); // comment
    b.writeUInt16LE(0, 34); // disk
    b.writeUInt16LE(0, 36); // internal attrs
    b.writeUInt32LE(((0o100644 << 16) >>> 0) as number, 38); // regular file, rw-r--r--
    b.writeUInt32LE(offBig ? U32_MAX : offset, 42);
    name.copy(b, 46);
    if (extraLen > 0) {
        let x = 46 + name.length;
        b.writeUInt16LE(0x0001, x);
        b.writeUInt16LE(extraLen - 4, x + 2);
        x += 4;
        if (p.big) {
            u64(b, x, p.size);
            u64(b, x + 8, p.size);
            x += 16;
        }
        if (offBig) u64(b, x, offset);
    }
    return b;
}

function endRecords(count: number, t: Totals): Buffer {
    const parts: Buffer[] = [];
    if (t.zip64Eocd) {
        const z = Buffer.alloc(56);
        z.writeUInt32LE(SIG_EOCD64, 0);
        u64(z, 4, 44);
        z.writeUInt16LE(45, 12);
        z.writeUInt16LE(45, 14);
        z.writeUInt32LE(0, 16);
        z.writeUInt32LE(0, 20);
        u64(z, 24, count);
        u64(z, 32, count);
        u64(z, 40, t.cdSize);
        u64(z, 48, t.cdOffset);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(SIG_LOCATOR64, 0);
        loc.writeUInt32LE(0, 4);
        u64(loc, 8, t.cdOffset + t.cdSize);
        loc.writeUInt32LE(1, 16);
        parts.push(z, loc);
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(SIG_EOCD, 0);
    e.writeUInt16LE(0, 4);
    e.writeUInt16LE(0, 6);
    const n = t.zip64Eocd ? U16_MAX : count;
    e.writeUInt16LE(n, 8);
    e.writeUInt16LE(n, 10);
    e.writeUInt32LE(t.zip64Eocd ? U32_MAX : t.cdSize, 12);
    e.writeUInt32LE(t.zip64Eocd ? U32_MAX : t.cdOffset, 16);
    e.writeUInt16LE(0, 20);
    parts.push(e);
    return Buffer.concat(parts);
}

/**
 * Produce the archive as a stream of chunks. The entries are consumed lazily, one file open at
 * a time. Stopping the iteration early destroys the file being read.
 *
 * Throws (so the consumer's stream errors) on an unsafe name, or when a file delivers more or
 * fewer bytes than its announced `size`.
 */
export async function* zipStoreStream(
    entries: Iterable<ZipEntrySource> | AsyncIterable<ZipEntrySource>,
    opts: ZipOptions = {},
): AsyncGenerator<Uint8Array, void, undefined> {
    const central: Buffer[] = [];
    let offset = 0;
    let count = 0;
    let cdSize = 0;

    const signal = opts.signal;
    for await (const entry of entries) {
        if (signal?.aborted) throw new Error('ZIP stream aborted');
        const name = checkName(entry.name);
        const p = plan(entry, opts);
        const dt = dosDateTime(entry.mtime);
        const header = localHeader(name, p, dt);
        const entryOffset = offset;
        yield header;
        offset += header.length;

        const source = await entry.openSource();
        const onAbort = () => source.destroy(new Error('ZIP stream aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        let crc = 0;
        let seen = 0;
        try {
            for await (const chunk of source) {
                const buf = chunk as Buffer;
                seen += buf.length;
                if (seen > p.size) {
                    throw new Error(
                        `ZIP entry size mismatch: ${JSON.stringify(entry.name.slice(0, 80))} is longer than the announced ${p.size} bytes`,
                    );
                }
                crc = crc32Update(crc, buf);
                yield buf;
            }
        } finally {
            signal?.removeEventListener('abort', onAbort);
            if (!source.destroyed) source.destroy();
        }
        if (seen !== p.size) {
            throw new Error(
                `ZIP entry size mismatch: ${JSON.stringify(entry.name.slice(0, 80))} delivered ${seen} of the announced ${p.size} bytes`,
            );
        }
        offset += seen;
        const dd = descriptor(crc, p);
        yield dd;
        offset += dd.length;

        const ch = centralHeader(name, p, dt, crc, entryOffset, opts);
        central.push(ch);
        cdSize += ch.length;
        count += 1;
    }

    for (const ch of central) yield ch;
    const zip64Eocd =
        opts.forceZip64 === true || count > U16_MAX || offset >= U32_MAX || cdSize >= U32_MAX;
    yield endRecords(count, { cdSize, cdOffset: offset, zip64Eocd, total: 0 });
}

/**
 * The archive as a Node Readable. Destroying it (client gone, watchdog) aborts the generator's
 * signal first, so the file being read is destroyed even when its read is stalled.
 */
export function zipStoreReadable(
    entries: Iterable<ZipEntrySource> | AsyncIterable<ZipEntrySource>,
    opts: ZipOptions = {},
): Readable {
    const ac = new AbortController();
    const readable = Readable.from(zipStoreStream(entries, { ...opts, signal: ac.signal }), {
        objectMode: false,
        highWaterMark: 256 * 1024,
    });
    const destroy = readable.destroy.bind(readable);
    readable.destroy = (err?: Error) => {
        ac.abort();
        return destroy(err);
    };
    return readable;
}
