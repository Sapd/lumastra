// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Local trickplay provider.
 *
 * Reads trickplay parameters from locally-generated sprite sheets managed by
 * trickplay-storage.service.ts.
 */

import {
    defineTrickplayProvider,
    type PluginContext,
    type TrickplayParams,
} from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '$lib/server/config.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    getAvailableTrickplayWidths,
    getTrickplayManifest,
    type TrickplayManifest,
} from '$lib/server/services/trickplay-storage.service.js';

// This provider only ever READS local sprite sheets to answer playback-time
// param queries — it never generates. So it follows TRICKPLAY_SERVE_LOCAL
// (serving), NOT TRICKPLAY_ENABLED (generation): a read-only consumer replica
// advertises the trickplay another instance wrote to shared storage. The
// jellyfin_disk / DISABLE_LOCAL_TRICKPLAY kill switches are folded into
// TRICKPLAY_SERVE_LOCAL, so this stays a single check.
function disabledByEnv(): boolean {
    return !config.TRICKPLAY_SERVE_LOCAL;
}

function manifestToParams(
    mediaItemId: string,
    width: number,
    manifest: TrickplayManifest,
): TrickplayParams | null {
    if (manifest.sheets.length === 0) return null;
    if (!manifest.interval || !manifest.tileWidth || !manifest.tileHeight) return null;
    return {
        url: `/api/playback/${mediaItemId}/trickplay/${width}?index={index}`,
        tileWidth: manifest.tileWidth,
        tileHeight: manifest.tileHeight,
        interval: manifest.interval,
        columns: manifest.tileWidth,
        rows: manifest.tileHeight,
        // Real total across every sheet — manifest.thumbnailCount is the
        // generator's own count of frames actually extracted, not the
        // single-sheet tile capacity.
        thumbnailCount: manifest.thumbnailCount,
        thumbnailHeight: manifest.height,
    };
}

async function resolveFile(
    ctx: PluginContext,
    mediaItemId: string,
): Promise<{ fileId: string; mediaFilePath: string | null } | null> {
    const selection = await resolvePlaybackSelection(ctx.sql, mediaItemId, {});
    if (!selection.fileId) return null;
    // Pick the row matching the resolved default fileId — `files` is ordered
    // by sort_order, so files[0] may not be the default on multi-version items.
    const matched = selection.files.find((f) => f.id === selection.fileId) ?? selection.files[0];
    return {
        fileId: selection.fileId,
        mediaFilePath: matched?.file_path ?? null,
    };
}

export const localTrickplayProvider = defineTrickplayProvider({
    id: 'local-trickplay',
    capabilities: { http: false, cache: false, database: true },

    async fetchParams(ctx, params) {
        if (disabledByEnv()) return null;

        const { mediaItemId, width } = params;
        const file = await resolveFile(ctx, mediaItemId);
        if (!file) return null;

        let manifest: TrickplayManifest | null;
        try {
            manifest = await getTrickplayManifest(file.fileId, width, file.mediaFilePath);
        } catch (err) {
            // Manifest read failures (FS permission, malformed manifest.json)
            // shouldn't escape as unhandled rejections — caller treats null as
            // "no trickplay available" and falls back gracefully.
            ctx.logger.warn('local trickplay: getTrickplayManifest threw', {
                fileId: file.fileId,
                width,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        if (!manifest) return null;

        const result = manifestToParams(mediaItemId, width, manifest);
        if (!result) {
            // Zero-dim or empty manifest — log once and refuse rather than
            // emitting params that would divide-by-zero on the client.
            ctx.logger.warn(
                'local trickplay: refusing manifest with zero dimensions or no sheets',
                {
                    fileId: file.fileId,
                    width,
                    interval: manifest.interval,
                    tileWidth: manifest.tileWidth,
                    tileHeight: manifest.tileHeight,
                    sheets: manifest.sheets.length,
                },
            );
            return null;
        }

        ctx.logger.debug('Found local trickplay params', {
            mediaItemId,
            fileId: file.fileId,
            width,
        });
        return result;
    },

    async discoverParams(ctx, { mediaItemId }) {
        if (disabledByEnv()) return null;

        const file = await resolveFile(ctx, mediaItemId);
        if (!file) return null;

        let widths: number[];
        try {
            widths = await getAvailableTrickplayWidths(file.fileId, file.mediaFilePath);
        } catch (err) {
            ctx.logger.warn('local trickplay: getAvailableTrickplayWidths threw', {
                fileId: file.fileId,
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        if (widths.length === 0) return [];

        // Manifests in parallel — each is a single JSON file read.
        const manifests = await Promise.all(
            widths.map(async (width) => {
                try {
                    const m = await getTrickplayManifest(file.fileId, width, file.mediaFilePath);
                    return m ? { width, manifest: m } : null;
                } catch {
                    return null;
                }
            }),
        );

        const out: Array<{ width: number; params: TrickplayParams }> = [];
        for (const m of manifests) {
            if (!m) continue;
            const params = manifestToParams(mediaItemId, m.width, m.manifest);
            if (params) {
                out.push({ width: m.width, params });
            } else {
                // Match fetchParams' warn-on-zero-dim observability so partial
                // wipes / corrupt manifests show up the same way regardless
                // of which entry-point the service used.
                ctx.logger.warn('local trickplay: skipping zero-dim width in discover', {
                    mediaItemId,
                    fileId: file.fileId,
                    width: m.width,
                    interval: m.manifest.interval,
                    tileWidth: m.manifest.tileWidth,
                    tileHeight: m.manifest.tileHeight,
                    sheets: m.manifest.sheets.length,
                });
            }
        }
        return out;
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerTrickplay(localTrickplayProvider);
