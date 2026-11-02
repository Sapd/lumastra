// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/library-probe — admin-only: sample a candidate folder's
 * contents and report whether they look like the media type the operator is
 * about to register, so the wizard can flag "you picked Movies but this looks
 * like a music folder" BEFORE a completed-but-empty scan is the only signal.
 *
 * TRUST MODEL: an admin can already point `setup/library` at any path and scan
 * it, so an admin probing an arbitrary path here is the same trust level — this
 * endpoint just samples file extensions, it never reads file contents. Still,
 * the walk never follows symlinks out of the tree (skipped via dirent type,
 * which `fs.readdir(withFileTypes)`/`safeReaddir` reports without following the
 * link), and the response only ever carries extensions + counts — never file
 * names — so it stays non-enumerating.
 *
 * The sample walk is strictly bounded: depth <= 3 and stops after collecting
 * 200 file entries or visiting 100 directories, whichever comes first — this
 * runs on the same network-mount-safe `safe-fs` wrappers as the rest of the
 * app, but a folder with millions of entries must not turn a UI hint into a
 * slow scan of its own.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { extname, join } from 'node:path';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import { isPathReadable } from '$lib/server/preflight/dependency-checks.js';
import { safeReaddir } from '$lib/server/utils/safe-fs.js';

const ENDPOINT = '/api/setup/library-probe';

/** Same media types `setup/library` accepts. */
const MEDIA_TYPES = [
    'movie',
    'tv',
    'anime',
    'music',
    'audiobook',
    'home_video',
    'training',
    'educational',
    'personal',
] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

/** Media types whose folders are expected to contain video files; everything
 * else (music, audiobook) is expected to contain audio. */
const EXPECT_VIDEO = new Set<MediaType>([
    'movie',
    'tv',
    'anime',
    'home_video',
    'training',
    'educational',
    'personal',
]);

const VIDEO_EXTS = new Set([
    'mkv',
    'mp4',
    'avi',
    'm4v',
    'mov',
    'ts',
    'webm',
    'wmv',
    'mpg',
    'mpeg',
    'flv',
]);
const AUDIO_EXTS = new Set([
    'flac',
    'mp3',
    'm4a',
    'm4b',
    'ogg',
    'opus',
    'wav',
    'aac',
    'wma',
    'aiff',
    'alac',
    'ape',
]);

/** Bounded-walk limits. */
const MAX_DEPTH = 3;
const MAX_FILES = 200;
const MAX_DIRS = 100;

type InferredKind = 'video' | 'audio' | 'mixed' | 'empty' | 'unknown';

interface SampleResult {
    filesSampled: number;
    extCounts: Map<string, number>;
    dirsVisited: number;
}

/**
 * Bounded sample walk. Never follows symlinks (skipped via the readdir dirent's
 * own type check — `withFileTypes` reports the link itself without following
 * it), so it can never escape the probed tree. Stops as soon as either cap is
 * hit, mid-directory if necessary.
 */
async function sampleWalk(root: string): Promise<SampleResult> {
    const extCounts = new Map<string, number>();
    const state = { filesSampled: 0, dirsVisited: 0 };

    async function walk(dir: string, depth: number): Promise<void> {
        if (state.filesSampled >= MAX_FILES || state.dirsVisited >= MAX_DIRS) return;

        let entries;
        try {
            entries = await safeReaddir(dir);
        } catch {
            return; // permission/timeout — treat this subtree as unreadable, not fatal
        }
        state.dirsVisited += 1;

        for (const entry of entries) {
            if (state.filesSampled >= MAX_FILES || state.dirsVisited >= MAX_DIRS) return;

            // Never follow symlinks (file or directory) out of the tree.
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                if (depth < MAX_DEPTH) {
                    await walk(join(dir, entry.name), depth + 1);
                }
                continue;
            }

            if (!entry.isFile()) continue; // sockets/fifos/etc. — not a signal

            const ext = extname(entry.name).toLowerCase().replace(/^\./, '');
            state.filesSampled += 1;
            if (ext) extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
    }

    await walk(root, 0);
    return { filesSampled: state.filesSampled, extCounts, dirsVisited: state.dirsVisited };
}

function classify(result: SampleResult): InferredKind {
    // The root readdir itself never succeeded — we couldn't sample anything.
    if (result.dirsVisited === 0) return 'unknown';

    let videoCount = 0;
    let audioCount = 0;
    for (const [ext, count] of result.extCounts) {
        if (VIDEO_EXTS.has(ext)) videoCount += count;
        else if (AUDIO_EXTS.has(ext)) audioCount += count;
    }
    const mediaTotal = videoCount + audioCount;
    if (mediaTotal === 0) return 'empty';

    const videoRatio = videoCount / mediaTotal;
    const audioRatio = audioCount / mediaTotal;
    if (videoRatio >= 0.2 && audioRatio >= 0.2) return 'mixed';
    return videoCount > audioCount ? 'video' : 'audio';
}

function topExtensions(extCounts: Map<string, number>): Array<{ ext: string; count: number }> {
    return [...extCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([ext, count]) => ({ ext, count }));
}

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        const path = toStringOr(body.path, '').trim();
        const mediaType = toStringOr(body.mediaType, '') as MediaType;
        if (!path || !path.startsWith('/')) {
            return ApiResponses.badRequest(
                'An absolute folder path is required',
                undefined,
                ENDPOINT,
            );
        }
        if (!MEDIA_TYPES.includes(mediaType)) {
            return ApiResponses.badRequest('Unknown media type', undefined, ENDPOINT);
        }

        // Same trust level as setup/library: an admin can already scan any path.
        if (!(await isPathReadable(path))) {
            return json({ ok: true, readable: false });
        }

        const result = await sampleWalk(path);
        const inferredKind = classify(result);
        const expectedKind = EXPECT_VIDEO.has(mediaType) ? 'video' : 'audio';
        const mismatch =
            (expectedKind === 'video' && inferredKind === 'audio') ||
            (expectedKind === 'audio' && inferredKind === 'video');

        return json({
            ok: true,
            readable: true,
            inferredKind,
            mismatch,
            sampleExtensions: topExtensions(result.extCounts),
            filesSampled: result.filesSampled,
        });
    }),
);
