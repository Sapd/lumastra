// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared file change detection for the file scanner.
 *
 * Implements the mtime → size → hash comparison used by both video and audio
 * processors. Preserves video's fast-path optimisation: when mtime + size +
 * hash are all stable, returns 'unchanged' without computing a new hash
 * (avoids a 64 KB head-read per unchanged file).
 */

import type { Stats } from 'node:fs';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';

export type ChangeStatus =
    | 'unchanged' // mtime, size, hash all match — skip (no hash computed)
    | 'metadata-only' // mtime/size changed but hash unchanged — update stat only
    | 'content-changed' // hash changed — caller must invalidate/re-parse
    | 'first-backfill' // no stored mtime/hash — store initial values
    | 'deleted' // file vanished mid-scan (ENOENT/ESTALE) — benign churn, skip
    | 'error'; // stat/hash failed with a genuine fault (EACCES / EIO / timeout)

export interface ChangeResult {
    status: ChangeStatus;
    fileStat?: Stats;
    currentHash?: string; // undefined when 'unchanged' (fast-path skipped hashing)
}

/**
 * Detect whether a file has changed since its last scan.
 *
 * Decision tree:
 *   1. No stored mtime/hash → first-backfill (compute hash, store everything)
 *   2. Mtime + size unchanged + hash exists → unchanged (skip hash, fast-path)
 *   3. Size differs → content-changed, always (a size delta can't come from a
 *      legitimate metadata-only cause like touch/backup-restore, so it wins
 *      over the head-hash even if that hash coincidentally matches)
 *   4. Mtime differs (size didn't) → compute hash:
 *      a. Hash differs → content-changed
 *      b. Hash matches → metadata-only (touch/backup restore)
 *   5. Hash differs but neither size nor mtime did → content-changed (NFS edge case)
 *   6. stat/hash throws → error
 */
/** Minimal shape required by detectFileChanges — satisfied by both MediaFileRow and KnownFileRow. */
export interface FileChangeInput {
    file_mtime: Date | null;
    file_size_bytes: number | null;
    file_hash_head: string | null;
}

/**
 * ENOENT (file deleted mid-scan) and ESTALE (NFS handle to a deleted file) are
 * benign churn — the file legitimately disappeared between enumeration and
 * change-detection. Collapsing them into 'error' inflates error counts and
 * triggers false "broken scan" alarms now that error outcomes surface in run
 * history. The rest of the scanner already special-cases these codes (watcher.ts,
 * audio-processor.ts); mirror that here so only genuine faults (EACCES / EIO /
 * timeout) become 'error'. Linux libuv sometimes emits ESTALE as bare errno -116
 * without a symbolic `code`.
 */
function isBenignMissingFileError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as { code?: unknown; errno?: unknown };
    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'ENOENT' || code === 'ESTALE') return true;
    if (typeof e.errno === 'number' && e.errno === -116) return true;
    return false;
}

export async function detectFileChanges(
    existingFile: FileChangeInput,
    filePath: string,
): Promise<ChangeResult> {
    let fileStat: Stats;
    try {
        fileStat = await safeStat(filePath);
    } catch (err) {
        return { status: isBenignMissingFileError(err) ? 'deleted' : 'error' };
    }

    // 1. First-time backfill: no stored mtime/hash yet
    if (!existingFile.file_mtime && !existingFile.file_hash_head) {
        let currentHash: string | undefined;
        try {
            currentHash = await hashFileHead(filePath);
        } catch (err) {
            return { status: isBenignMissingFileError(err) ? 'deleted' : 'error' };
        }
        return { status: 'first-backfill', fileStat, currentHash };
    }

    const mtimeChanged =
        !existingFile.file_mtime ||
        Math.abs(fileStat.mtimeMs - existingFile.file_mtime.getTime()) > 1000;

    const sizeChanged =
        existingFile.file_size_bytes !== null && existingFile.file_size_bytes !== fileStat.size;

    const sizeConfirmedUnchanged =
        existingFile.file_size_bytes !== null && existingFile.file_size_bytes === fileStat.size;

    // 2. Fast-path: mtime and size unchanged, hash exists → skip hashing
    if (!mtimeChanged && sizeConfirmedUnchanged && existingFile.file_hash_head) {
        return { status: 'unchanged', fileStat };
    }

    // 3. Something looks different — compute hash
    let currentHash: string;
    try {
        currentHash = await hashFileHead(filePath);
    } catch (err) {
        return { status: isBenignMissingFileError(err) ? 'deleted' : 'error' };
    }

    const hashChanged =
        existingFile.file_hash_head !== null && existingFile.file_hash_head !== currentHash;

    // A size delta is unambiguous: 'metadata-only' causes (touch, backup
    // restore) never change file size, only mtime. So if size changed, the
    // content changed — full stop, independent of what the 64KB head-hash
    // says. Relying on the head hash here was the bug: two different video
    // files (e.g. a repack/remux replacing the original) can share a
    // byte-identical header region and coincidentally hash the same, which
    // silently downgraded a real replacement to 'metadata-only' and skipped
    // ALL content invalidation (streams, chapters, segments, trickplay,
    // artwork) with no error or retry path.
    if (sizeChanged) {
        return { status: 'content-changed', fileStat, currentHash };
    }

    if (mtimeChanged) {
        if (hashChanged || !existingFile.file_hash_head) {
            return { status: 'content-changed', fileStat, currentHash };
        }
        // Mtime changed but size + head hash identical (touch, backup restore)
        return { status: 'metadata-only', fileStat, currentHash };
    }

    // 4. NFS edge case: content changed without mtime update
    if (hashChanged) {
        return { status: 'content-changed', fileStat, currentHash };
    }

    // Backfill hash if missing
    if (!existingFile.file_hash_head) {
        return { status: 'first-backfill', fileStat, currentHash };
    }

    return { status: 'unchanged', fileStat, currentHash };
}
