// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { sep, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { hasControlChars } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/filename-safety.js';

/**
 * Lexical containment: returns the in-root absolute path, or null if rel escapes/invalid.
 *
 * `opts.allowControlChars` (M4, fix plan 6, Task 7 fix round 2): a row
 * written before the control-char guard existed can have one baked into its
 * stored path forever otherwise — file-delta-ingest's REMOVE op (deletion
 * only) passes this to retire such a row. The add/update/move (upsert) call
 * site never sets it, so a control character in an INCOMING path is still
 * rejected. Every other containment check (`..`, absolute, `\`, empty
 * segments, symlink escape via `realpathUnderRoot`) still applies regardless
 * of this option — it lifts nothing but the control-char check.
 */
export function resolveUnderRoot(
    realRoot: string,
    rel: string,
    opts?: { allowControlChars?: boolean },
): string | null {
    if (!rel || rel === '.' || rel.startsWith('/') || rel.includes('\\')) return null;
    // F4 (fix plan 6, Task 7 fix round 1): a control character survives every
    // check above (it is neither `..`, a leading `/`, nor `\`) — reject it
    // the same way the filename seams do, via the same shared helper.
    if (!opts?.allowControlChars && hasControlChars(rel)) return null;
    if (rel.split('/').some((s) => s === '..' || s === '')) return null;
    const abs = resolve(realRoot, rel);
    if (abs !== realRoot && !abs.startsWith(realRoot + sep)) return null;
    return abs;
}

/**
 * Re-assert containment AFTER resolving symlinks. Async because it stats the FS.
 *
 * `abs` must be the output of `resolveUnderRoot`. Only ENOENT is caught (a
 * not-yet-visible in-root file is legitimate); any other error (EACCES, ELOOP,
 * ENOTDIR, …) is re-thrown. Because no full re-check is possible when the file
 * doesn't exist, the ENOENT branch re-asserts lexical containment as
 * defense-in-depth.
 */
export async function realpathUnderRoot(realRoot: string, abs: string): Promise<string | null> {
    try {
        const real = await realpath(abs);
        return real === realRoot || real.startsWith(realRoot + sep) ? real : null;
    } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
        // not-yet-visible file: safe only if still lexically in-root
        return abs === realRoot || abs.startsWith(realRoot + sep) ? abs : null;
    }
}

/** Longest-prefix match of a full object-store URI to a configured library root.
 *
 * Returns `null` when no root matches OR when two distinct roots share the same
 * longest matching prefix (ambiguous — cannot safely route to one library).
 */
export function resolveSourceUri(
    sourceUri: string,
    roots: Array<{ id: string; sourcePrefix: string | null }>,
): { libraryPathId: string; rel: string } | null {
    let best: { libraryPathId: string; rel: string; len: number } | null = null;
    let ambiguous = false;
    for (const r of roots) {
        if (!r.sourcePrefix) continue;
        const p = r.sourcePrefix.endsWith('/') ? r.sourcePrefix : r.sourcePrefix + '/';
        if (!sourceUri.startsWith(p)) continue;
        const rel = sourceUri.slice(p.length);
        if (!best || p.length > best.len) {
            best = { libraryPathId: r.id, rel, len: p.length };
            ambiguous = false;
        } else if (p.length === best.len && r.id !== best.libraryPathId) {
            ambiguous = true;
        }
    }
    if (!best || ambiguous) return null;
    return { libraryPathId: best.libraryPathId, rel: best.rel };
}
