// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Params Service
 *
 * DB-first cache for trickplay parameters. On cache miss, queries the new
 * task-registry trickplay providers and persists to DB for future lookups.
 *
 * Providers expose `fetchParams(ctx, { mediaItemId, width })` per the SDK
 * `TrickplayProviderDefinition` contract — one width at a time. The service
 * probes a fixed set of canonical widths so callers can still pick a best
 * resolution via `selectBestResolution`.
 */

import type { TrickplayInfo } from '$lib/schemas/playback-types.js';
import type { TrickplayProviderDefinition, TrickplayParams } from '@sapd/lumastra-plugin-sdk';
import { providerIdToSource } from './trickplay-provider-source.js';
import { aiDbService } from './database.service.js';
import {
    getTrickplayParams,
    upsertTrickplayParams,
    deleteTrickplayParams,
    toTrickplayInfo,
} from '../database/queries/trickplay-params.queries.js';
import type { UpsertTrickplayParam } from '../database/queries/trickplay-params.queries.js';
import { registry as taskRegistry } from '../tasks/registry.js';
import { buildPluginContext } from '../tasks/plugin-context.js';
import { Logger } from '../utils/logger.js';
import { resolvePlaybackSelection } from '../database/queries/media-file-resolution.queries.js';

const logger = Logger.for('TrickplayParams');

// Canonical widths probed on cache miss. The route URL specifies one of these;
// `selectBestResolution` picks 320 first (tvOS sweet spot) and falls back to
// the closest >= 320.
const PROBE_WIDTHS = [160, 320, 480, 640] as const;

// Provider priority — local first (faster, no Jellyfin call), jellyfin-disk
// as fallback for libraries served from Jellyfin's pre-generated sprites.
const PROVIDER_PRIORITY = ['local-trickplay', 'jellyfin-disk-trickplay'] as const;

/**
 * Select the best resolution from a list of TrickplayInfo.
 * Prefers 320px width for tvOS performance, or closest resolution >= 320.
 */
function selectBestResolution(params: TrickplayInfo[]): TrickplayInfo | null {
    if (params.length === 0) return null;

    const sorted = [...params].sort((a, b) => a.width - b.width);
    return sorted.find((p) => p.width >= 320) ?? sorted[sorted.length - 1];
}

/**
 * Build a legacy TrickplayInfo shape from the SDK TrickplayParams response.
 *
 * The SDK contract returns `{url, tileWidth, tileHeight, interval, columns,
 * rows, thumbnailCount?}`; the DB cache + admin UI consume the wider
 * `TrickplayInfo` shape with `width/height/bandwidth/thumbnailCount`. Derive
 * the missing fields:
 *   - `width` from the iteration value (the request shape is per-width)
 *   - `height` is the provider's `thumbnailHeight`. Older/external providers
 *     that omit it get a 16:9 guess, stored with `heightMeasured: false`;
 *     the guess misplaces every row for 4:3 or scope sources
 *   - `bandwidth = width` matches legacy convention (used as a quality proxy)
 *   - `thumbnailCount` prefers the provider's real total; `columns × rows` is
 *     only a single sheet's tile capacity and was previously used directly
 *     here, which silently truncated every multi-sheet item's cached count
 *     to one sheet's worth (T-BUG: AVPlayer's synthetic I-frame trickplay
 *     rendition inherits this value as its declared duration, so it fell
 *     dramatically short of the real runtime and desynced/looped on scrub).
 *     Kept as a fallback for providers that haven't been updated to supply it.
 */
type ProbedTrickplayInfo = TrickplayInfo & { heightMeasured: boolean };

function trickplayParamsToInfo(params: TrickplayParams, width: number): ProbedTrickplayInfo {
    const thumbnailHeight = params.thumbnailHeight;
    const measured =
        typeof thumbnailHeight === 'number' &&
        Number.isInteger(thumbnailHeight) &&
        thumbnailHeight > 0;
    return {
        width,
        height: measured ? thumbnailHeight : Math.round((width * 9) / 16),
        heightMeasured: measured,
        tileWidth: params.tileWidth,
        tileHeight: params.tileHeight,
        thumbnailCount: params.thumbnailCount ?? params.columns * params.rows,
        interval: params.interval,
        bandwidth: width,
    };
}

function withoutMeasuredFlag({ heightMeasured, ...info }: ProbedTrickplayInfo): TrickplayInfo {
    void heightMeasured;
    return info;
}

function trickplayInfoToUpsert(info: ProbedTrickplayInfo, source: string): UpsertTrickplayParam {
    return {
        width: info.width,
        height: info.height,
        heightMeasured: info.heightMeasured,
        intervalMs: info.interval,
        tileWidth: info.tileWidth,
        tileHeight: info.tileHeight,
        thumbnailCount: info.thumbnailCount,
        bandwidth: info.bandwidth,
        source,
    };
}

/** Order providers by configured priority so the local one is tried first. */
function orderedProviders(): TrickplayProviderDefinition[] {
    const all = taskRegistry.getAllTrickplays();
    const byId = new Map(all.map((p) => [p.id, p] as const));
    const ordered: TrickplayProviderDefinition[] = [];
    for (const id of PROVIDER_PRIORITY) {
        const found = byId.get(id);
        if (found) {
            ordered.push(found);
            byId.delete(id);
        }
    }
    // Append any other registered trickplay providers (external plugins) at the end.
    return [...ordered, ...byId.values()];
}

export const trickplayParamsService = {
    /**
     * Get best-resolution trickplay params for a media item.
     * DB-first; on miss probes registered providers at canonical widths and
     * caches every successful response.
     *
     * `options.signal` aborts between provider attempts so a stop click
     * doesn't wait for every fallback provider.
     */
    async getParams(
        internalId: string,
        _jellyfinId?: string,
        options: { signal?: AbortSignal; fileId?: string | null } = {},
    ): Promise<TrickplayInfo | null> {
        const sql = await aiDbService.getSql();
        if (!sql) return null;

        let selectedFileId: string | undefined;
        try {
            const selection = await resolvePlaybackSelection(sql, internalId, {
                fileId: options.fileId,
            });
            selectedFileId = selection.fileId ?? undefined;
        } catch (err) {
            logger.warn('resolvePlaybackSelection failed', {
                internalId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        if (!selectedFileId) return null;

        // DB-first lookup. A transient DB error here shouldn't crash playback
        // — fall through to provider probing and re-cache on success.
        try {
            const cached = await getTrickplayParams(sql, internalId, selectedFileId);
            if (cached.length > 0) {
                return selectBestResolution(cached.map(toTrickplayInfo));
            }
        } catch (err) {
            logger.warn('getTrickplayParams cache lookup failed', {
                internalId,
                fileId: selectedFileId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // Cache miss — probe each provider for canonical widths.
        const providers = orderedProviders();
        if (providers.length === 0) return null;

        for (const provider of providers) {
            if (options.signal?.aborted) return null;

            const ctx = buildPluginContext(provider.id, {
                signal: options.signal,
            });

            // Prefer the provider's batch discovery when available: ONE
            // upstream call returns every width the provider has on disk.
            // Avoids the 4× duplicated readdir / DB-lookup work that
            // parallel-`fetchParams` couldn't eliminate, and skips sharp
            // decodes for widths that aren't even on disk.
            let collected: ProbedTrickplayInfo[] = [];

            if (typeof provider.discoverParams === 'function') {
                let discovered: Awaited<ReturnType<NonNullable<typeof provider.discoverParams>>> =
                    null;
                try {
                    discovered = await provider.discoverParams(ctx, {
                        mediaItemId: internalId,
                    });
                } catch (err) {
                    logger.warn('trickplay provider discoverParams threw', {
                        providerId: provider.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                // Re-check abort after the upstream call. discoverParams can
                // be slow (parallel sharp decodes for jellyfin-disk); if the
                // user cancelled during that, skip the rest of the providers.
                if (options.signal?.aborted) return null;
                if (discovered === null) {
                    // Provider opted out (disabled by env / not applicable to
                    // this item). Skip to the next provider. Note that `[]`
                    // and `null` produce identical control-flow at this layer
                    // — both fall through — but the contract still
                    // distinguishes them so providers can signal intent
                    // (and future error/metric paths can differentiate).
                    continue;
                }
                // Guard against untyped JS plugins returning a non-array.
                // TS-typed providers can't trip this, but external drop-in
                // plugins are JS-only and easy to write wrong.
                if (!Array.isArray(discovered)) {
                    logger.warn('trickplay provider discoverParams returned non-array', {
                        providerId: provider.id,
                        typeofResult: typeof discovered,
                    });
                    continue;
                }
                for (const { width, params } of discovered) {
                    if (params.interval > 0 && params.tileWidth > 0 && params.tileHeight > 0) {
                        collected.push(trickplayParamsToInfo(params, width));
                    } else {
                        logger.warn('trickplay provider returned zero-dim params; ignoring', {
                            providerId: provider.id,
                            width,
                            interval: params.interval,
                            tileWidth: params.tileWidth,
                            tileHeight: params.tileHeight,
                        });
                    }
                }
            } else {
                // Fallback: probe canonical widths via per-width fetchParams.
                // Parallel so total ≈ max(per-width) instead of sum.
                const probeResults = await Promise.all(
                    PROBE_WIDTHS.map(async (width) => {
                        if (options.signal?.aborted)
                            return {
                                width,
                                params: null as Awaited<ReturnType<typeof provider.fetchParams>>,
                            };
                        try {
                            const params = await provider.fetchParams(ctx, {
                                mediaItemId: internalId,
                                width,
                            });
                            return { width, params };
                        } catch (err) {
                            logger.warn('trickplay provider fetchParams threw', {
                                providerId: provider.id,
                                width,
                                error: err instanceof Error ? err.message : String(err),
                            });
                            return { width, params: null };
                        }
                    }),
                );

                collected = [];
                for (const { width, params } of probeResults) {
                    if (
                        params &&
                        params.interval > 0 &&
                        params.tileWidth > 0 &&
                        params.tileHeight > 0
                    ) {
                        collected.push(trickplayParamsToInfo(params, width));
                    } else if (params) {
                        logger.warn('trickplay provider returned zero-dim params; ignoring', {
                            providerId: provider.id,
                            width,
                            interval: params.interval,
                            tileWidth: params.tileWidth,
                            tileHeight: params.tileHeight,
                        });
                    }
                }
            }

            if (collected.length > 0) {
                const source = providerIdToSource(provider.id);
                try {
                    await upsertTrickplayParams(
                        sql,
                        internalId,
                        selectedFileId,
                        collected.map((r) => trickplayInfoToUpsert(r, source)),
                    );
                } catch (err) {
                    // Cache write failure shouldn't deny the player the params
                    // we just successfully probed — log and serve uncached.
                    logger.warn('upsertTrickplayParams failed; serving uncached', {
                        internalId,
                        fileId: selectedFileId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                logger.debug('Cached trickplay params from provider', {
                    internalId,
                    fileId: selectedFileId,
                    source,
                    resolutions: collected.length,
                });

                return selectBestResolution(collected.map(withoutMeasuredFlag));
            }
        }

        return null;
    },

    /**
     * Get all available resolutions for a media item.
     */
    async getAllParams(internalId: string, fileId?: string | null): Promise<TrickplayInfo[]> {
        const sql = await aiDbService.getSql();
        if (!sql) return [];

        const rows = await getTrickplayParams(sql, internalId, fileId);
        return rows.map(toTrickplayInfo);
    },

    /**
     * Quick check if params exist in DB.
     */
    async hasParams(internalId: string, fileId?: string | null): Promise<boolean> {
        const sql = await aiDbService.getSql();
        if (!sql) return false;

        const fileFilter = fileId ? sql`AND file_id = ${fileId}` : sql``;
        const rows = await sql<{ exists: boolean }[]>`
            SELECT EXISTS(
                SELECT 1 FROM trickplay_params
                WHERE media_item_id = ${internalId}
                  ${fileFilter}
            ) AS exists
        `;
        return rows[0]?.exists ?? false;
    },

    /**
     * Invalidate cached params for a media item.
     */
    async invalidate(internalId: string, fileId?: string | null): Promise<void> {
        const sql = await aiDbService.getSql();
        if (!sql) return;

        await deleteTrickplayParams(sql, internalId, fileId);
        logger.debug('Invalidated trickplay params', { internalId, fileId });
    },
};
