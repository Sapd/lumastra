// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * fileId -> item scoping.
 *
 * A single, small module (no HTTP response shaping, no unrelated helpers) so
 * both `iframe-handler.ts` and `subtitle-handler.ts` can depend on it without
 * pulling each other's heavier transitive dependencies (Jellyfin client,
 * trickplay sprite-sheet providers, …) into each other's tests. Keep this
 * file's own imports minimal for the same reason — it is deliberately NOT
 * part of `hls-request-utils.ts` (which other modules partially mock via
 * `importOriginal` and must stay free of database imports).
 */

import { getDb } from '$lib/server/database/connection.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

/** A caller-supplied `fileId`, resolved and confirmed to belong to the gated item. */
export interface ResolvedScopedFile {
    fileId: string;
    mediaFilePath: string | null;
    probedAt: Date | null;
}

/**
 * Outcome of scoping a caller-supplied `fileId` to `internalId`, with no HTTP
 * response attached — different HLS sub-resources need different failure
 * bodies (the trickplay/I-frame handlers return plain text; the subtitle
 * segment handler must return a *valid empty WebVTT* body even on rejection,
 * or native players mis-parse it), so callers build their own Response from
 * the `status` below.
 */
export type FileScopeDecision =
    { ok: true; file: ResolvedScopedFile | null } | { ok: false; status: 400 | 404 };

/**
 * Validate a caller-supplied `fileId` query param and confirm it belongs to
 * `internalId` before it is ever used to look up — or embedded into a
 * playlist URL that will later look up — a file-scoped resource (a trickplay
 * sprite sheet, a subtitle's disk-cached text) on disk.
 *
 * Without this, `fileId` — a raw query param — could be passed straight to a
 * lookup keyed on `fileId` alone, with no check that it belongs to the item
 * the caller's route middleware actually gated. A caller authorized for item
 * X could then request `...&fileId=<a file that belongs only to item Y>` and
 * be served Y's data. `resolvePlaybackSelection` scopes the lookup to files
 * that actually belong to `internalId`.
 *
 * Shared by the trickplay/I-frame handlers (`iframe-handler.ts`'s
 * `resolveTrickplayFile`, 2026-09-13 fix plan Task 12, C27) and the HLS
 * subtitle segment handler (`subtitle-handler.ts`, 2026-09-24 fix plan 6
 * C1-sibling, research §10.3) — do not fork a third copy of this DB scoping
 * check; wrap this decision in a handler-appropriate Response instead.
 *
 * - No `fileId` supplied at all → `{ ok: true, file: null }` (caller's
 *   existing "fileId required" handling applies further down).
 * - Malformed (not UUID-shaped, e.g. a path-traversal payload) → `{ ok:
 *   false, status: 400 }`, before any DB or filesystem access.
 * - DB unavailable, `internalId` unresolved, or the file doesn't belong to
 *   this item → `{ ok: false, status: 404 }` (same status either way —
 *   existence must not leak).
 *
 * Can reject the underlying `resolvePlaybackSelection` call — callers that
 * must return a well-formed body even on an unexpected DB error (the
 * subtitle segment handler) should await this inside their own try/catch.
 */
export async function resolveFileScopedToItem(
    rawFileId: string | null,
    internalId: string | undefined,
): Promise<FileScopeDecision> {
    if (!rawFileId) return { ok: true, file: null };

    if (!UUID_RE.test(rawFileId)) {
        return { ok: false, status: 400 };
    }

    const sql = getDb();
    if (!sql || !internalId) {
        return { ok: false, status: 404 };
    }

    const sel = await resolvePlaybackSelection(sql, internalId, { fileId: rawFileId });
    if (!sel.fileId) {
        return { ok: false, status: 404 };
    }

    return {
        ok: true,
        file: {
            fileId: sel.fileId,
            mediaFilePath: sel.files[0]?.file_path ?? null,
            probedAt: sel.files[0]?.probed_at ?? null,
        },
    };
}
