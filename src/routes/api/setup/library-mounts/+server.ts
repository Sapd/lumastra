// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/setup/library-mounts — admin-only: suggest candidate media folders so
 * the first-run wizard's "add library" step can render click-to-fill chips instead
 * of the operator typing a mount path blind.
 *
 * SECURITY MODEL: this endpoint takes NO input whatsoever (no query string, no
 * body) — it only ever lists immediate children of a FIXED set of well-known
 * container mount roots (`/data`, `/media`, `/mnt`, `/srv`, `/music`, `/movies`,
 * `/series`, `/tv`). There is nothing here for an admin to point at an arbitrary
 * path; that capability lives (deliberately, at the same trust level) in
 * `setup/library` and `setup/library-probe`.
 *
 * For each root that exists, list its immediate child directories (skipping
 * dotdirs and common non-media system folders), and also surface the root itself
 * when it directly contains files. A child that only groups libraries (the
 * example compose mounts one `/data/media` holding `movies/`, `series/`, `music/`)
 * is replaced by those subfolders, so the chips name real libraries. That second
 * level is entered only when a subfolder is named like a library, never for a
 * movies folder full of per-title folders. Every candidate gets a
 * cheap directory listing to report a child count, letting the UI prefer
 * non-empty folders. A candidate that errors (permission denied, timeout) is
 * dropped silently rather than failing the whole request.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { join } from 'node:path';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { safeReaddir, safeStat } from '$lib/server/utils/safe-fs.js';
import { LIBRARY_MOUNT_ROOTS } from '$lib/server/utils/library-mount-roots.js';
import { isAudiobookFolderName, isLibraryFolderName } from '$lib/shared/library-folder-names.js';

/** Fixed candidate roots — never derived from request input. */
const ROOTS: readonly string[] = LIBRARY_MOUNT_ROOTS;

/** Dotdirs aside, folder names that are never plausible media candidates. */
const NON_MEDIA_DIR_NAMES = new Set([
    'lost+found',
    'system volume information',
    '$recycle.bin',
    'recycle.bin',
    '@eadir',
    '#recycle',
    // Download clients' working folders sit next to the libraries on many shares.
    'downloads',
    'incomplete',
    'torrents',
    'tmp',
    'temp',
]);

/** Per-root cap on immediate child directories considered as candidates. */
const PER_ROOT_CHILD_CAP = 10;
/** Overall cap on candidates returned. */
const TOTAL_CANDIDATE_CAP = 20;
/** Reported child-count is capped — purely a display bound, not a read bound. */
const ENTRIES_REPORT_CAP = 500;

interface Candidate {
    path: string;
    entries: number;
}

/** Files an OS or file manager leaves in any folder; they say nothing about media. */
function isClutterFile(name: string): boolean {
    return name.startsWith('.') || /^(?:thumbs\.db|desktop\.ini)$/i.test(name);
}

function isMediaDirName(name: string): boolean {
    return (
        !name.startsWith('.') &&
        !NON_MEDIA_DIR_NAMES.has(name.toLowerCase()) &&
        // Audiobooks come only from Audiobookshelf; no library type scans them.
        !isAudiobookFolderName(name)
    );
}

/** Count directory entries for a candidate, capped for display. Never throws. */
async function countEntries(path: string): Promise<number | null> {
    try {
        const entries = await safeReaddir(path);
        return Math.min(entries.length, ENTRIES_REPORT_CAP);
    } catch {
        return null;
    }
}

async function collectCandidates(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];

    for (const root of ROOTS) {
        let stat;
        try {
            stat = await safeStat(root);
        } catch {
            continue; // root does not exist / unreadable — skip silently
        }
        if (!stat.isDirectory()) continue;

        let dirents;
        try {
            dirents = await safeReaddir(root);
        } catch {
            continue;
        }

        // Root itself is a candidate when it directly contains files.
        if (dirents.some((d) => d.isFile())) {
            const entries = await countEntries(root);
            if (entries !== null) candidates.push({ path: root, entries });
        }

        let childCount = 0;
        for (const dirent of dirents) {
            if (childCount >= PER_ROOT_CHILD_CAP) break;
            if (!dirent.isDirectory()) continue;
            if (!isMediaDirName(dirent.name)) continue;

            const childPath = join(root, dirent.name);
            let children;
            try {
                children = await safeReaddir(childPath);
            } catch {
                continue; // permission/timeout — skip silently
            }

            const subdirs = children.filter((d) => d.isDirectory() && isMediaDirName(d.name));
            // A folder that is itself named like a library ("movies") is one, even
            // with genre folders inside ("movies/Kids"). OS clutter files
            // (.DS_Store, Thumbs.db) do not make a grouping folder a library.
            const groupsLibraries =
                !isLibraryFolderName(dirent.name) &&
                !children.some((d) => d.isFile() && !isClutterFile(d.name)) &&
                subdirs.some((d) => isLibraryFolderName(d.name));
            if (!groupsLibraries) {
                candidates.push({
                    path: childPath,
                    entries: Math.min(children.length, ENTRIES_REPORT_CAP),
                });
                childCount += 1;
                continue;
            }

            for (const sub of subdirs) {
                if (childCount >= PER_ROOT_CHILD_CAP) break;
                const subPath = join(childPath, sub.name);
                const entries = await countEntries(subPath);
                if (entries === null) continue;
                candidates.push({ path: subPath, entries });
                childCount += 1;
            }
        }
    }

    // Non-empty before empty, then alphabetical.
    candidates.sort((a, b) => {
        const aEmpty = a.entries === 0;
        const bEmpty = b.entries === 0;
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
        return a.path.localeCompare(b.path);
    });

    return candidates.slice(0, TOTAL_CANDIDATE_CAP);
}

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const candidates = await collectCandidates();
        return json({ candidates });
    }),
);
