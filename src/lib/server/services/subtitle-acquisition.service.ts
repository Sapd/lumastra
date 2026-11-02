// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subtitle acquisition — searching plugin-supplied subtitle providers and
 * installing what the user picks.
 *
 * Deliberately separate from `subtitle-resolver.service.ts`, which SERVES
 * subtitles that already exist. This module is the other half: finding a
 * subtitle that does not exist yet and turning it into an external subtitle
 * file. Once installed, the resolver serves it by the ordinary path and never
 * needs to know a plugin was involved.
 */

import type {
    PluginContext,
    SubtitleCandidate,
    SubtitleProviderDefinition,
    SubtitleSearchQuery,
} from '@sapd/lumastra-plugin-sdk';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type postgres from 'postgres';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { isPathWithinMediaStore } from '$lib/server/utils/media-path-resolver.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import {
    getExternalSubtitlesForFile,
    upsertExternalSubtitle,
} from '$lib/server/database/queries/external-subtitles.queries.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SubtitleAcquisition');

/** Per-provider search budget. One slow service must not hold up the picker. */
const SEARCH_TIMEOUT_MS = 15_000;
/**
 * Budget for one download. Longer than search — a subtitle file is a real
 * transfer — but bounded: search wraps every plugin call and install did not,
 * so a hung provider pinned the operator's request open with nothing to show
 * for it and no way to learn why.
 */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** A candidate, tagged with the provider that offered it. */
export interface AttributedCandidate extends SubtitleCandidate {
    providerId: string;
}

export interface SubtitleAcquisitionDeps {
    listProviders(): SubtitleProviderDefinition[];
    buildCtx(providerId: string): PluginContext;
}

const defaultDeps: SubtitleAcquisitionDeps = {
    listProviders: () => taskRegistry.getAllSubtitleProviders(),
    buildCtx: (id) => buildPluginContext(id),
};

const VALID_FORMATS = new Set(['srt', 'ass', 'ssa', 'vtt', 'sub']);

/**
 * Is this object usable as a candidate?
 *
 * Plugins are third-party code and a malformed entry here would surface as a
 * broken row in the picker or a download call with an undefined id. Anything
 * the host must be able to act on is required; everything else is advisory.
 */
function isUsableCandidate(c: unknown): c is SubtitleCandidate {
    if (!c || typeof c !== 'object') return false;
    const v = c as Record<string, unknown>;
    return (
        typeof v.id === 'string' &&
        v.id.length > 0 &&
        typeof v.language === 'string' &&
        v.language.length > 0 &&
        typeof v.format === 'string' &&
        VALID_FORMATS.has(v.format)
    );
}

/** Await `p`, resolving to `null` on rejection or after `ms`. Never rejects. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

/**
 * Order candidates for presentation. See the test file for the reasoning behind
 * each tier; in short:
 *
 *   1. the viewer's language preference order — a perfectly-timed subtitle in a
 *      language they cannot read is worth less than a decent one they can;
 *   2. an exact file-hash match, which is the difference between subtitles that
 *      stay in sync and subtitles that drift;
 *   3. popularity, then rating, as tie-breakers.
 */
export function rankCandidates(
    candidates: AttributedCandidate[],
    languages: string[],
): AttributedCandidate[] {
    const langRank = new Map(languages.map((l, i) => [l.toLowerCase(), i]));
    const rankOf = (c: AttributedCandidate): number =>
        langRank.get(c.language.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;

    return [...candidates].sort((a, b) => {
        const byLang = rankOf(a) - rankOf(b);
        if (byLang !== 0) return byLang;
        const byHash = Number(b.hashMatch ?? false) - Number(a.hashMatch ?? false);
        if (byHash !== 0) return byHash;
        const byDownloads = (b.downloadCount ?? 0) - (a.downloadCount ?? 0);
        if (byDownloads !== 0) return byDownloads;
        return (b.rating ?? 0) - (a.rating ?? 0);
    });
}

/**
 * Search every configured subtitle provider and return ranked candidates.
 *
 * Providers are queried concurrently and isolated: one that throws, hangs or
 * returns nonsense contributes nothing and is logged, while the rest still
 * produce a usable list. A search that finds nothing is a normal outcome, not
 * an error.
 */
export async function searchSubtitleCandidates(
    query: SubtitleSearchQuery,
    deps: SubtitleAcquisitionDeps = defaultDeps,
): Promise<AttributedCandidate[]> {
    let providers: SubtitleProviderDefinition[];
    try {
        providers = deps.listProviders();
    } catch (err) {
        logger.warn('failed to list subtitle providers', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
    if (providers.length === 0) return [];

    const wanted = new Set(query.languages.map((l) => l.toLowerCase()));

    const perProvider = await Promise.all(
        providers.map(async (def): Promise<AttributedCandidate[]> => {
            let ctx: PluginContext;
            try {
                ctx = deps.buildCtx(def.id);
            } catch (err) {
                logger.warn('could not build context for subtitle provider', {
                    provider: def.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                return [];
            }

            if (typeof def.isConfigured === 'function') {
                const configured = await settleWithin(
                    Promise.resolve(def.isConfigured(ctx)),
                    SEARCH_TIMEOUT_MS,
                );
                // Unconfigured, or the check itself failed — either way, do not
                // call search(): a provider without its API key would just
                // produce an error per query.
                if (configured !== true) return [];
            }

            const raw = await settleWithin(
                Promise.resolve(def.search(ctx, query)),
                SEARCH_TIMEOUT_MS,
            );
            if (raw === null) {
                logger.warn('subtitle provider search failed or timed out', {
                    provider: def.id,
                });
                return [];
            }
            if (!Array.isArray(raw)) {
                logger.warn('subtitle provider returned a non-array', { provider: def.id });
                return [];
            }

            return raw
                .filter(isUsableCandidate)
                .filter((c) => wanted.has(c.language.toLowerCase()))
                .map((c) => ({ ...c, providerId: def.id }));
        }),
    );

    return rankCandidates(perProvider.flat(), query.languages);
}

// ---------------------------------------------------------------------------
// Installing a chosen candidate
// ---------------------------------------------------------------------------

/**
 * Upper bound on a downloaded subtitle.
 *
 * Pinned to the resolver's own read limit on purpose: accepting anything larger
 * here would write a file that the serving path then refuses to read back, so
 * the user would see a successful download and a subtitle that never appears.
 */
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/** Language codes are pasted into a filename, so they must be inert there. */
const SAFE_LANGUAGE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

export interface NormalizedDownload {
    bytes: Buffer;
    format: 'srt' | 'ass' | 'ssa' | 'vtt' | 'sub';
}

/**
 * Validate what a provider handed back and reduce it to bytes.
 *
 * Everything here arrives from third-party code, so nothing is assumed: an
 * empty body, a format the host cannot serve, or a file too big for the reader
 * are all rejected before anything touches the filesystem.
 */
export function normalizeDownload(download: {
    content: string | Uint8Array;
    format: string;
}): NormalizedDownload {
    if (!VALID_FORMATS.has(download.format)) {
        throw new Error(
            `subtitle provider returned an unsupported format '${download.format}' ` +
                `(expected one of ${[...VALID_FORMATS].join(', ')})`,
        );
    }
    const bytes =
        typeof download.content === 'string'
            ? Buffer.from(download.content, 'utf8')
            : Buffer.from(download.content);

    if (bytes.length === 0) {
        throw new Error('subtitle provider returned an empty file');
    }
    if (bytes.length > MAX_SUBTITLE_BYTES) {
        throw new Error(
            `subtitle is too large (${bytes.length} bytes, limit ${MAX_SUBTITLE_BYTES})`,
        );
    }
    return { bytes, format: download.format as NormalizedDownload['format'] };
}

/**
 * Where a downloaded subtitle goes: beside its video, named the way scanners
 * and players already expect (`Movie.en.srt`, `Movie.en.forced.srt`).
 *
 * `taken` lets the caller pass the paths already in use so a second English
 * subtitle does not silently overwrite the first — the existing row is keyed on
 * `subtitle_path`, so a collision would replace rather than add.
 */
export function sidecarPathFor(
    videoPath: string,
    opts: { language: string; format: string; isForced?: boolean; isSDH?: boolean },
    taken: ReadonlySet<string> = new Set(),
): string {
    if (!SAFE_LANGUAGE.test(opts.language)) {
        throw new Error(
            `subtitle provider returned an unusable language tag '${opts.language}' — ` +
                'expected an ISO 639 code such as "en" or "pt-BR"',
        );
    }
    const dir = path.dirname(videoPath);
    const stem = path.basename(videoPath, path.extname(videoPath));
    const marker = opts.isForced ? '.forced' : opts.isSDH ? '.sdh' : '';

    const build = (suffix: string): string =>
        path.join(dir, `${stem}.${opts.language}${marker}${suffix}.${opts.format}`);

    let candidate = build('');
    for (let n = 2; taken.has(candidate); n++) {
        candidate = build(`.${n}`);
    }
    return candidate;
}

export interface InstallSubtitleResult {
    subtitlePath: string;
    language: string;
    format: NormalizedDownload['format'];
}

/**
 * Download one candidate and install it as an external subtitle for a file.
 *
 * The subtitle lands beside its video as a sidecar, which is the same shape the
 * library scanner already discovers, so nothing downstream needs to know it
 * arrived from a plugin — the resolver serves it by the ordinary path.
 *
 * Throws with an operator-readable message on every failure. Unlike search,
 * this is a deliberate user action on one provider: swallowing the reason would
 * leave them with a button that silently does nothing.
 */
export async function installSubtitleCandidate(
    sql: postgres.Sql,
    args: {
        mediaItemId: string;
        fileId: string;
        providerId: string;
        candidateId: string;
        language: string;
        isForced?: boolean;
        isSDH?: boolean;
        signal?: AbortSignal;
    },
    deps: SubtitleAcquisitionDeps = defaultDeps,
): Promise<InstallSubtitleResult> {
    const def = deps.listProviders().find((p) => p.id === args.providerId);
    if (!def) {
        throw new Error(`subtitle provider '${args.providerId}' is not loaded`);
    }

    const files = await getFilesForMediaItem(sql, args.mediaItemId);
    const file = files.find((f) => f.id === args.fileId);
    if (!file) {
        throw new Error('media file not found for this item');
    }

    // The sidecar is written next to the video, so the video itself must be
    // somewhere we are willing to write. This is the same guard the resolver
    // applies when reading an external subtitle back.
    const videoPath = path.resolve(file.file_path);
    if (!(await isPathWithinMediaStore(sql, videoPath))) {
        throw new Error('media file is outside the configured library roots');
    }

    const raw = await settleWithin(
        Promise.resolve(def.download(deps.buildCtx(def.id), args.candidateId, args.signal)),
        DOWNLOAD_TIMEOUT_MS,
    );
    if (!raw) {
        // Unlike search, this is a deliberate action on ONE provider, so the
        // reason has to reach the operator rather than being swallowed.
        throw new Error(
            `subtitle provider '${def.id}' did not respond within ${DOWNLOAD_TIMEOUT_MS / 1000}s`,
        );
    }
    const { bytes, format } = normalizeDownload(raw);
    const language = raw.language ?? args.language;

    // Existing sidecars for this file, so a second subtitle in the same
    // language gets its own name instead of overwriting the first (the row is
    // keyed on subtitle_path, so a collision would replace it).
    const existing = await getExternalSubtitlesForFile(sql, file.id);
    const taken = new Set(existing.map((e) => path.resolve(e.subtitle_path)));

    const subtitlePath = sidecarPathFor(
        videoPath,
        { language, format, isForced: args.isForced, isSDH: args.isSDH },
        taken,
    );

    // `wx` — never clobber a file that exists on disk but is not in the
    // registry (a hand-placed sidecar the scanner has not picked up yet).
    await writeFile(subtitlePath, bytes, { flag: 'wx' });

    await upsertExternalSubtitle(sql, {
        fileId: file.id,
        subtitlePath,
        language,
        format,
        isForced: args.isForced ?? false,
        isSDH: args.isSDH ?? false,
    });

    logger.info('installed subtitle from provider', {
        provider: def.id,
        mediaItemId: args.mediaItemId,
        language,
        format,
    });

    return { subtitlePath, language, format };
}
