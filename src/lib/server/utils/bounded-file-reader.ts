// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

interface FileReader {
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
}

/**
 * Read at most cap+1 bytes, without a stat/read race. An oversized file returns
 * null without concatenation: at most cap+1 bytes of buffers are allocated.
 * Successful small outputs retain their actual size, rather than a cap-sized buffer.
 */
export async function readBoundedFile(file: FileReader, cap: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= cap) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, cap + 1 - total));
        let used = 0;
        while (used < chunk.length) {
            const { bytesRead } = await file.read(chunk, used, chunk.length - used, total + used);
            if (bytesRead === 0) break;
            used += bytesRead;
        }
        total += used;
        if (total > cap) return null;
        if (used > 0) chunks.push(chunk.subarray(0, used));
        if (used < chunk.length) break;
    }
    // Buffer.concat may return its sole input unchanged. Explicitly copy into
    // exact-sized storage so a short final chunk never retains its 64 KiB buffer.
    const result = Buffer.allocUnsafeSlow(total);
    let offset = 0;
    for (const chunk of chunks) {
        chunk.copy(result, offset);
        offset += chunk.length;
    }
    return result;
}
