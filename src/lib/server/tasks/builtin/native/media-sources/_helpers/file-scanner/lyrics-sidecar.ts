// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sidecar-lyrics catch-up helpers.
 *
 * The scanner's change detection keys off the *audio file's* own mtime/size/
 * hash, so a lyrics sidecar (`.lrc`/`.txt`) dropped or edited next to an
 * otherwise-unchanged track is invisible to it. These helpers let the scanner
 * (and the live watcher) detect such sidecars and (re-)ingest their lyrics into
 * `media_items.custom_metadata.lyrics`, while never clobbering manually
 * uploaded (`source: 'user'`) lyrics.
 */

import path from 'node:path';
import type postgres from 'postgres';
import { findSidecarLyrics } from '$lib/server/utils/music-scanner-utils.js';
import { AUDIO_EXTENSIONS } from '$lib/server/utils/walk-directory.js';

/** Lyrics state as persisted under `custom_metadata.lyrics`. */
export interface StoredLyricsState {
    source?: string | null;
    sidecarPath?: string | null;
    sidecarMtimeMs?: number | null;
}

/** NUL — can never appear in a filesystem path, so it's a collision-proof join. */
const STEM_KEY_SEP = String.fromCharCode(0);

/**
 * Index key for matching a sidecar to its sibling audio track: parent
 * directory + stem (extension stripped). Case-sensitive — filenames on the
 * target filesystems (Linux/Docker) are byte-exact, and `findSidecarLyrics`
 * derives the sidecar name from the audio stem the same way.
 */
export function sidecarStemKey(filePath: string): string {
    const dir = path.dirname(filePath);
    const stem = path.basename(filePath, path.extname(filePath));
    return `${dir}${STEM_KEY_SEP}${stem}`;
}

/**
 * Build a lookup from stem key → the sidecar paths sharing that stem. A stem
 * can have both a `.lrc` and a `.txt`; both are recorded so the refresh
 * decision can notice a higher-priority `.lrc` appearing over a stored `.txt`.
 */
export function buildSidecarStemIndex(sidecarPaths: string[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const p of sidecarPaths) {
        const key = sidecarStemKey(p);
        const existing = index.get(key);
        if (existing) existing.push(p);
        else index.set(key, [p]);
    }
    return index;
}

/**
 * Decide whether a track whose audio file is otherwise unchanged should be
 * reprocessed because of its lyrics sidecar(s). Pure — the caller supplies the
 * current on-disk mtime of the previously-stored sidecar path (or null when it
 * can't be stat'd / wasn't walk-visible), so this stays unit-testable.
 *
 * Rules, in order:
 *   - No walk-visible sidecar for the stem        → false (nothing to ingest)
 *   - Existing lyrics were user-uploaded          → false (never overwrite)
 *   - No lyrics yet, or sourced from anything but a file (embedded/lrclib)
 *                                                  → true  (file wins)
 *   - File-sourced already; a `.lrc` now exists over a stored non-`.lrc`
 *                                                  → true  (priority upgrade)
 *   - File-sourced with no stored path (legacy)    → true  (backfill path+mtime)
 *   - File-sourced, stored path no longer visible  → false (central/app-managed)
 *   - File-sourced, stored mtime missing/changed   → true  (in-place edit)
 */
export function sidecarLyricsNeedsRefresh(
    lyrics: StoredLyricsState | null | undefined,
    stemSidecars: string[],
    storedPathCurrentMtimeMs: number | null,
): boolean {
    if (stemSidecars.length === 0) return false;

    const source = lyrics?.source;
    if (source === 'user') return false;
    if (!lyrics || source !== 'file') return true;

    const storedPath = (lyrics.sidecarPath ?? '').toLowerCase();
    const hasLrc = stemSidecars.some((p) => p.toLowerCase().endsWith('.lrc'));
    if (hasLrc && !storedPath.endsWith('.lrc')) return true;

    if (!lyrics.sidecarPath) return true;
    if (storedPathCurrentMtimeMs === null) return false;
    if (lyrics.sidecarMtimeMs == null) return true;
    return Math.abs(storedPathCurrentMtimeMs - lyrics.sidecarMtimeMs) > 1;
}

/**
 * (Re-)ingest sidecar lyrics for a single track. Reads the sidecar via
 * {@link findSidecarLyrics}, then writes it to `custom_metadata.lyrics` unless
 * the existing lyrics were user-uploaded. Returns the outcome so callers can
 * log/aggregate.
 *
 * Shared by the batch scanner backfill and the live watcher so the
 * source-priority gate lives in exactly one place.
 */
export async function applySidecarLyricsToTrack(
    sql: postgres.Sql,
    mediaItemId: string,
    audioFilePath: string,
): Promise<'updated' | 'skipped-user' | 'no-sidecar'> {
    const sidecar = await findSidecarLyrics(audioFilePath);
    if (!sidecar) return 'no-sidecar';

    // Atomic, concurrency-safe: merge only the `lyrics` key via jsonb `||`
    // rather than read-modify-write the whole column (which would clobber a
    // concurrent update to a different custom_metadata key). The `WHERE` guard
    // keeps user-uploaded lyrics untouched.
    const updated = await sql`
        UPDATE media_items
        SET custom_metadata =
            COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json({ lyrics: sidecar } as unknown as Record<string, never>)}
        WHERE id = ${mediaItemId}
          AND COALESCE(custom_metadata->'lyrics'->>'source', '') <> 'user'
        RETURNING id
    `;
    return updated.length > 0 ? 'updated' : 'skipped-user';
}

/**
 * Clear file-sourced lyrics from the sibling track when its sidecar is deleted.
 * Only touches `source: 'file'` rows whose stored `sidecarPath` matches the
 * removed file — user-uploaded, embedded, and lrclib lyrics are left intact,
 * and a stale path from a different sidecar won't be wiped. No-op when the
 * remaining `.lrc`/`.txt` (if any) will be re-read on the next scan.
 */
export async function clearSidecarLyricsForDeletedFile(
    sql: postgres.Sql,
    sidecarPath: string,
): Promise<boolean> {
    const dir = path.dirname(sidecarPath);
    const stem = path.basename(sidecarPath, path.extname(sidecarPath));
    const candidates = [...AUDIO_EXTENSIONS].map((ext) => path.join(dir, `${stem}${ext}`));

    const cleared = await sql`
        UPDATE media_items track
        SET custom_metadata = track.custom_metadata - 'lyrics'
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        WHERE mfi.media_item_id = track.id
          AND track.media_type = 'track'
          AND mf.file_path = ANY(${candidates})
          AND track.custom_metadata->'lyrics'->>'source' = 'file'
          AND track.custom_metadata->'lyrics'->>'sidecarPath' = ${sidecarPath}
        RETURNING track.id
    `;
    return cleared.length > 0;
}

/** Outcome of a live watcher sidecar-lyrics event. */
export type WatchSidecarOutcome = 'updated' | 'skipped-user' | 'no-sidecar' | 'no-track';

/**
 * Handle a `.lrc`/`.txt` add/change event from the live watcher: locate the
 * sibling audio track (same directory + stem, any audio extension) and ingest
 * the sidecar's lyrics into it. No-op when no matching track is registered yet
 * (the track will pick the sidecar up when it is itself scanned).
 */
export async function ingestSidecarLyricsForWatchedFile(
    sql: postgres.Sql,
    sidecarPath: string,
): Promise<{ outcome: WatchSidecarOutcome; audioPath?: string }> {
    const dir = path.dirname(sidecarPath);
    const stem = path.basename(sidecarPath, path.extname(sidecarPath));
    const candidates = [...AUDIO_EXTENSIONS].map((ext) => path.join(dir, `${stem}${ext}`));

    const rows = await sql<{ id: string; file_path: string }[]>`
        SELECT track.id, mf.file_path
        FROM media_files mf
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items track
          ON track.id = mfi.media_item_id
         AND track.media_type = 'track'
        WHERE mf.file_path = ANY(${candidates})
        LIMIT 1
    `;
    if (rows.length === 0) return { outcome: 'no-track' };

    const outcome = await applySidecarLyricsToTrack(sql, rows[0].id, rows[0].file_path);
    return { outcome, audioPath: rows[0].file_path };
}
