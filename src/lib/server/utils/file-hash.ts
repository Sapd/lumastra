// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'crypto';
import { open } from 'node:fs/promises';
import { withFsGuard } from './safe-fs.js';

const HASH_BYTES = 65536; // 64 KB

/**
 * Compute SHA-256 of the first 64KB of a file.
 *
 * Container headers (in the first few KB) change on any re-encode, making
 * head-only hashing effective for detecting content replacements. 64KB is
 * ~0.0003% of a 20GB movie file — the read is near-instant.
 *
 * Routed through the global fs guard: a library scan hashes thousands of files
 * over the (possibly NFS) media mount, and without the cap these open+read pairs
 * fan out unbounded onto the libuv threadpool — starving DNS/DB connects. The
 * whole open→read→close holds ONE permit (counted as a single fs op).
 */
export async function hashFileHead(filePath: string): Promise<string> {
    return withFsGuard(
        async () => {
            const fh = await open(filePath, 'r');
            try {
                const buf = Buffer.allocUnsafe(HASH_BYTES);
                // fh.read() may return a SHORT read (fewer bytes than requested) —
                // per Node's docs this happens notably on slow/network filesystems.
                // Our media libraries are NFS-mounted and scanned concurrently, so a
                // single read intermittently returned a truncated buffer → a SHA-256
                // that differed from the stored full-64KB hash even when the file was
                // byte-for-byte unchanged → files spuriously flagged 'content-changed'
                // (resetting library_added_at, resurfacing ancient episodes as "new").
                // Loop until we've filled HASH_BYTES or hit EOF so the hash is stable.
                let total = 0;
                while (total < HASH_BYTES) {
                    const { bytesRead } = await fh.read(buf, total, HASH_BYTES - total, total);
                    if (bytesRead === 0) break; // EOF — file smaller than 64KB
                    total += bytesRead;
                }
                return createHash('sha256').update(buf.subarray(0, total)).digest('hex');
            } finally {
                await fh.close();
            }
        },
        'hashFileHead',
        filePath,
    );
}
