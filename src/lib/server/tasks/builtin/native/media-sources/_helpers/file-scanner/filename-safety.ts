// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A filename or path containing a raw C0 control character (U+0000-U+001F —
 * including a literal `\n`/`\r`) or DEL (U+007F) is rejected wherever it is
 * accepted or written, via this one shared check rather than a patch per
 * call site.
 *
 * Why this matters: `writeConcatTmpFile` (`services/hls/playback.service.ts`,
 * via `buildConcatListContent`) joins one `file '<path>'` directive per line
 * into an ffmpeg concat list opened with `-f concat -safe 0`. Its quote
 * escaping (the POSIX-shell `'` → `'\''` trick) has no answer for an
 * embedded newline byte — a path containing one splits the list into an
 * attacker-influenced extra `file` directive. Node's `basename()`
 * (`upload-session.service.ts`) does not strip embedded control bytes
 * either, and `library-path-safety.ts`'s segment check rejects `..`/`\`/an
 * absolute path but not a control character, so nothing upstream of the
 * concat writer stops one today.
 *
 * Applied at every seam a filename or path segment can cross on its way to
 * that concat list: the upload `init.ts` zod schema, for both `filename` and
 * `destinationFolder` (422 `validation_failed`, before an upload session is
 * even created); `resolveUnderRoot` (`library-path-safety.ts`), the shared
 * containment chokepoint the upload service, the ancillary-upload endpoint,
 * and file-delta-ingest's add/update/move ops all route through (its REMOVE
 * op is the one exception — see its own doc comment); the scanner's per-file
 * gate for both primary files (`video-processor.ts`) and extras
 * (`ancillary-processors.ts`), which skip and record a scan issue (see
 * `playlist-container.ts` for the sibling playlist-container gate); and
 * `writeConcatTmpFile` itself (throw, defense-in-depth — the concat list is
 * never written). More seams than there are call sites, since some (like
 * `resolveUnderRoot`) are shared by several callers.
 */
export function hasControlChars(name: string): boolean {
    // eslint-disable-next-line no-control-regex -- this IS the control-char detector
    return /[\x00-\x1f\x7f]/.test(name);
}
