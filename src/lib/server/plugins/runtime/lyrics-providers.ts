// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin-supplied lyrics.
 *
 * Lyrics came from exactly one hardcoded source, and adding a second meant
 * editing core. Providers are consulted BEFORE the builtin, and the first
 * non-empty answer wins: an operator who installed a provider did so because
 * they wanted it consulted, while falling through to the builtin keeps today's
 * behaviour for every track a plugin cannot help with.
 */

import type { LyricsProviderDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('PluginLyrics');

/** Per-provider budget. This sits in front of a user opening a lyrics pane. */
const LYRICS_TIMEOUT_MS = 8_000;

export interface LyricsQuery {
    trackId: string;
    title: string;
    artist: string | null;
    album: string | null;
    durationSeconds?: number | null;
}

/** Shaped like the builtin's result so the caller can treat both alike. */
export interface PluginLyricsResult {
    plainLyrics: string | null;
    syncedLyrics: string | null;
    providerId: string;
}

export interface LyricsProviderDeps {
    listProviders(): LyricsProviderDefinition[];
    buildCtx(providerId: string): PluginContext;
}

const defaultDeps: LyricsProviderDeps = {
    listProviders: () => taskRegistry.getAllLyricsProviders(),
    buildCtx: (id) => buildPluginContext(id),
};

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
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
 * Ask each configured lyrics provider in turn; return the first real answer.
 *
 * Sequential rather than concurrent, because the first non-empty answer wins —
 * asking everyone in parallel would spend every provider's rate limit to
 * discard all but one result.
 *
 * Never throws. A provider that fails, hangs or returns nothing simply does not
 * answer, and the caller falls through to the builtin.
 */
export async function fetchLyricsFromPlugins(
    query: LyricsQuery,
    deps: LyricsProviderDeps = defaultDeps,
): Promise<PluginLyricsResult | null> {
    let providers: LyricsProviderDefinition[];
    try {
        providers = deps.listProviders();
    } catch {
        return null;
    }
    if (providers.length === 0) return null;

    for (const def of providers) {
        try {
            const ctx = deps.buildCtx(def.id);
            if (typeof def.isConfigured === 'function') {
                const ok = await settleWithin(
                    Promise.resolve(def.isConfigured(ctx)),
                    LYRICS_TIMEOUT_MS,
                );
                if (ok !== true) continue;
            }
            const result = await settleWithin(
                Promise.resolve(def.fetchLyrics(ctx, query)),
                LYRICS_TIMEOUT_MS,
            );
            if (!result) continue;

            const plain = typeof result.plain === 'string' && result.plain ? result.plain : null;
            const synced =
                typeof result.synced === 'string' && result.synced ? result.synced : null;
            // A provider answering with neither has not answered.
            if (!plain && !synced) continue;

            return { plainLyrics: plain, syncedLyrics: synced, providerId: def.id };
        } catch (err) {
            logger.warn('lyrics provider threw', {
                provider: def.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return null;
}
