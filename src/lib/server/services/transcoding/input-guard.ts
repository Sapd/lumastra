// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refuse a video-transcode input whose CONTENT is a playlist/manifest body
 * (fix plan 6, final wave M1), before every FFmpeg spawn that reads it: a
 * job's start, its restore from a persisted row, a seek generation, a GPU
 * ladder respawn, and the tail-cache workers.
 *
 * The scanner refuses such files at ingest and tombstones one whose content
 * changed into a playlist body, but a transcode job persisted while the file
 * still held that body keeps its input path in `active_transcode_jobs.config`
 * and respawns FFmpeg from it on restore — no re-scan in between. The check is
 * the music plane's (`music-transcode/source-guard.ts`,
 * `assertTranscodeSourceIsMedia`), so both planes refuse exactly the files the
 * scanner refuses: one 4 KiB read for real media.
 *
 * An FFmpeg concat-demuxer job's input is the app's OWN list
 * (`writeConcatTmpFile`, hls/playback.service.ts), which is itself a concat
 * script and would be refused as one. Each part it names is sniffed instead.
 */

import { readFile } from 'node:fs/promises';
import {
    assertTranscodeSourceIsMedia,
    PlaylistSourceRefusedError,
} from '../music-transcode/source-guard.js';
import type { TranscodeJobConfig } from './types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { FsTimeoutError } from '$lib/server/utils/safe-fs.js';
import { FORMAT_WHITELIST_VALUE } from '$lib/server/utils/media-format-whitelist.js';

const logger = Logger.for('TranscodeInputGuard');

/** One line of `buildConcatListContent`'s output: `file '<escaped path>'`. */
const CONCAT_LIST_LINE = /^file '((?:[^']|'\\'')*)'$/;
/** Its optional per-part line (F4): `option format_whitelist '<demuxer list>'`. */
const CONCAT_OPTION_LINE = /^option format_whitelist '([^']*)'$/;

/**
 * Inverse of `buildConcatListContent` (hls/playback.service.ts): the part
 * paths of an app-written concat list, or `null` when any non-empty line is
 * not in that exact form (so the file is not a list this app wrote). That
 * builder refuses control characters, so a path never spans lines, and it
 * encodes a literal `'` as `'\''` — the only `'` inside the quotes. It may
 * follow each `file` line with ONE `option format_whitelist` line; one
 * anywhere else, with another key, or with a value outside
 * `FORMAT_WHITELIST_VALUE` is not its output. Lists written before F4 have
 * no option lines and still parse (a job restored across the upgrade).
 */
export function parseConcatListContent(body: string): string[] | null {
    const paths: string[] = [];
    let afterFile = false;
    for (const line of body.split('\n')) {
        if (line === '') continue;
        const m = CONCAT_LIST_LINE.exec(line);
        if (m) {
            paths.push(m[1].replaceAll("'\\''", "'"));
            afterFile = true;
            continue;
        }
        const option = CONCAT_OPTION_LINE.exec(line);
        if (afterFile && option && FORMAT_WHITELIST_VALUE.test(option[1])) {
            afterFile = false;
            continue;
        }
        return null;
    }
    return paths;
}

type InputConfig = Pick<TranscodeJobConfig, 'localFilePath' | 'useConcatDemuxer' | 'concatTmpFile'>;

/**
 * The files FFmpeg will demux for this job. A concat job whose input is its
 * own recorded temp list (`localFilePath === concatTmpFile`) yields the parts
 * that list names; any other input — including a "concat" input that is not
 * the job's own list — is returned as-is, so its content is judged directly.
 */
async function inputMediaPaths(config: InputConfig): Promise<string[]> {
    const input = config.localFilePath;
    if (!input) return [];
    if (!config.useConcatDemuxer || config.concatTmpFile !== input) return [input];

    const parts = parseConcatListContent(await readFile(input, 'utf-8'));
    if (!parts || parts.length === 0) {
        throw new Error(
            'Refusing transcode input: concat list is not in the format this app writes',
        );
    }
    return parts;
}

/**
 * An fs failure that says nothing about the file's content: an errno-coded
 * error (gone, permissions), or a guard timeout. `withFsGuard`'s permits are
 * shared process-wide, so a dead mount elsewhere can time out a sniff of a
 * file on a healthy mount; failing the spawn on that would block playback
 * everywhere (final wave F1).
 */
function isInconclusiveFsError(err: unknown): boolean {
    if (err instanceof FsTimeoutError) return true;
    return err instanceof Error && typeof (err as { code?: unknown }).code === 'string';
}

/**
 * Throw `PlaylistSourceRefusedError` (status 415) when the job's input — or,
 * for the app's own concat list, any part it names — is a playlist/manifest
 * body. Callers treat the throw as a failed spawn.
 *
 * A file this process cannot read (gone, permissions) is NOT refused here:
 * FFmpeg runs as the same user against the same path, fails on it too, and
 * reports it through the existing exit/diagnostic path (a missing input keeps
 * the failure message it always had). Nor is a guard timeout: it is logged
 * and the spawn proceeds. Only a positive content match refuses.
 */
export async function assertTranscodeInputIsMedia(config: InputConfig): Promise<void> {
    let paths: string[];
    try {
        paths = await inputMediaPaths(config);
    } catch (err) {
        if (!isInconclusiveFsError(err)) throw err;
        logger.warn('Transcode input list unreadable; leaving the failure to FFmpeg', {
            input: config.localFilePath,
            error: String(err),
        });
        return;
    }
    for (const p of paths) {
        try {
            await assertTranscodeSourceIsMedia(p);
        } catch (err) {
            if (err instanceof PlaylistSourceRefusedError || !isInconclusiveFsError(err)) throw err;
            logger.warn('Transcode input unreadable; leaving the failure to FFmpeg', {
                input: p,
                error: String(err),
            });
        }
    }
}
