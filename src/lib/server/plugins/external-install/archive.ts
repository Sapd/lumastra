// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import { isSafeRelativePath } from './manifest.js';

const BLOCK = 512;

export interface ArchiveLimits {
    maxTotalBytes: number;
    maxEntries: number;
    maxFileBytes: number;
}
export interface ExtractedFile {
    path: string;
    sha256: string;
    size: number;
}
export interface ExtractResult {
    files: ExtractedFile[];
    treeDigest: string;
}

/** Upper bound on the inflated ustar STREAM (file bytes + headers + padding + end blocks). */
export function tarStreamAllowance(limits: ArchiveLimits): number {
    return limits.maxTotalBytes + BLOCK * (2 * limits.maxEntries + 2);
}

/** Detect gzip by magic bytes; inflate with an early decompression-bomb cap. */
export function inflateIfGzip(archive: Buffer, limits: ArchiveLimits): Buffer {
    if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
        // Throws ERR_BUFFER_TOO_LARGE if the inflated stream exceeds the cap.
        return zlib.gunzipSync(archive, { maxOutputLength: tarStreamAllowance(limits) });
    }
    return archive;
}

/** Strict NUL/space-terminated octal. Rejects high-bit (base-256) + non-octal. */
function parseOctalStrict(buf: Buffer, off: number, len: number): number {
    let i = off;
    const end = off + len;
    while (i < end && (buf[i] === 0x20 || buf[i] === 0x00)) i++;
    let val = 0;
    let digits = 0;
    for (; i < end; i++) {
        const b = buf[i];
        if (b === 0x20 || b === 0x00) break;
        if ((b & 0x80) !== 0) throw new Error('unsupported numeric encoding');
        if (b < 0x30 || b > 0x37) throw new Error('unsupported numeric encoding');
        val = val * 8 + (b - 0x30);
        digits++;
    }
    return digits === 0 ? 0 : val;
}

function readCstr(buf: Buffer, off: number, len: number): string {
    let end = off;
    const max = off + len;
    while (end < max && buf[end] !== 0) end++;
    return buf.subarray(off, end).toString('utf8');
}

function isZeroBlock(block: Buffer): boolean {
    for (let i = 0; i < BLOCK; i++) if (block[i] !== 0) return false;
    return true;
}

function headerChecksumOk(block: Buffer): boolean {
    let unsigned = 0;
    for (let i = 0; i < BLOCK; i++) {
        unsigned += i >= 148 && i < 156 ? 0x20 : block[i];
    }
    const stored = parseOctalStrict(block, 148, 8);
    return unsigned === stored;
}

const listingLine = (f: ExtractedFile): string => `${f.sha256}  ${f.size}  ${f.path}\n`;

function sortedByPath(files: ExtractedFile[]): ExtractedFile[] {
    return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Canonical order-independent digest over the file listing. */
export function computeTreeDigestFromFiles(files: ExtractedFile[]): string {
    const listing = sortedByPath(files).map(listingLine).join('');
    return crypto.createHash('sha256').update(Buffer.from(listing, 'utf8')).digest('hex');
}

/** Parse + validate + extract a ustar archive. Rejects on the FIRST offender, before writing. */
export function extractTarball(
    archive: Buffer,
    destDir: string,
    limits: ArchiveLimits,
): ExtractResult {
    const destRoot = path.resolve(destDir);
    const files: ExtractedFile[] = [];
    const seen = new Set<string>();
    const seenLower = new Set<string>();
    let entryCount = 0;
    let totalBytes = 0;
    let offset = 0;
    let zeroBlocks = 0;
    let sawEnd = false;

    while (offset + BLOCK <= archive.length) {
        const block = archive.subarray(offset, offset + BLOCK);
        if (isZeroBlock(block)) {
            zeroBlocks++;
            offset += BLOCK;
            if (zeroBlocks === 2) {
                sawEnd = true;
                break;
            }
            continue;
        }
        zeroBlocks = 0;

        // 1. magic + header checksum
        const magic = block.subarray(257, 263).toString('latin1');
        if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('corrupt/not-ustar');
        if (!headerChecksumOk(block)) throw new Error('corrupt/not-ustar: bad header checksum');

        // size, validated against the actual remaining bytes (no over-read).
        const size = parseOctalStrict(block, 124, 12);
        const dataStart = offset + BLOCK;
        if (dataStart + size > archive.length) {
            throw new Error('declared size exceeds archive length');
        }
        const dataEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        // 2. typeflag gate — regular file only. (A '5'/link/device/pax/GNU entry
        //    throws here; nothing is written and we never desync because we abort.)
        const typeflag = block[156];
        if (typeflag !== 0x30 && typeflag !== 0x00) throw new Error('unsupported tar entry type');

        // 3. path gate + duplicate/case-fold guard
        const name = readCstr(block, 0, 100);
        const prefix = readCstr(block, 345, 155);
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (!isSafeRelativePath(relPath)) throw new Error('unsafe path');
        if (seen.has(relPath)) throw new Error('duplicate path in archive');
        const lower = relPath.toLowerCase();
        if (seenLower.has(lower)) throw new Error('duplicate path in archive (case-fold)');

        // 4. resolve-within-root assertion
        const resolved = path.resolve(destRoot, relPath);
        if (resolved !== destRoot && !resolved.startsWith(destRoot + path.sep)) {
            throw new Error('path escapes archive root');
        }

        // 5. bomb counters (compare BEFORE writing)
        if (entryCount + 1 > limits.maxEntries) throw new Error('too many entries');
        if (size > limits.maxFileBytes) throw new Error('file exceeds max size');
        if (totalBytes + size > limits.maxTotalBytes) {
            throw new Error('total extracted size exceeds max');
        }

        // 6. write (implicit parent dirs); ENOTDIR (file/dir collision) propagates → fail closed.
        const data = archive.subarray(dataStart, dataStart + size);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, data, { mode: 0o644 });
        files.push({
            path: relPath,
            sha256: crypto.createHash('sha256').update(data).digest('hex'),
            size,
        });
        seen.add(relPath);
        seenLower.add(lower);
        entryCount++;
        totalBytes += size;
        offset = dataEnd;
    }

    // NORMATIVE (§8.1): the two-zero-block end marker MUST be present. A truncated
    // archive whose bytes happen to end on a header/data boundary would otherwise
    // parse as a valid smaller tree — accepting it weakens the "archive bytes ==
    // signed checksum" framing (any block-aligned prefix would be a valid bundle).
    if (!sawEnd) throw new Error('missing end-of-archive blocks');

    const sorted = sortedByPath(files);
    return { files: sorted, treeDigest: computeTreeDigestFromFiles(sorted) };
}

/** Re-derive the tree digest from an already-extracted dir (boot/enable/reload). */
export function computeTreeDigest(rootDir: string, limits: ArchiveLimits): ExtractResult {
    const root = path.resolve(rootDir);
    const files: ExtractedFile[] = [];
    let entryCount = 0;
    let totalBytes = 0;

    const walk = (absDir: string): void => {
        const names = fs.readdirSync(absDir);
        for (const nm of names) {
            const abs = path.join(absDir, nm);
            const st = fs.lstatSync(abs); // NEVER statSync — observe symlinks as symlinks
            if (abs !== root && !abs.startsWith(root + path.sep)) {
                throw new Error('bundle tree walk escapes root');
            }
            if (st.isDirectory()) {
                walk(abs);
                continue;
            }
            if (!st.isFile()) throw new Error('bundle tree contains non-regular entry');
            entryCount++;
            if (entryCount > limits.maxEntries) throw new Error('bundle tree exceeds max entries');
            const rel = path.relative(root, abs).split(path.sep).join('/');
            if (!isSafeRelativePath(rel)) throw new Error('bundle tree contains unsafe path');
            if (st.size > limits.maxFileBytes) throw new Error('bundle tree file exceeds max size');
            totalBytes += st.size;
            if (totalBytes > limits.maxTotalBytes) {
                throw new Error('bundle tree exceeds max total size');
            }
            const data = fs.readFileSync(abs);
            files.push({
                path: rel,
                sha256: crypto.createHash('sha256').update(data).digest('hex'),
                size: st.size,
            });
        }
    };
    walk(root);
    const sorted = sortedByPath(files);
    return { files: sorted, treeDigest: computeTreeDigestFromFiles(sorted) };
}
