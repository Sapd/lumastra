// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Provider Factory
 *
 * Returns the active LiveTV provider based on the LIVETV_SOURCE config.
 * This is a lazy singleton — the provider is created once on first call.
 *
 * Routes should ONLY import from this file, never from individual provider files.
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { LiveTvSourceConfigSchema } from '$lib/schemas/livetv.js';

const logger = Logger.for('LiveTV');
import type { LiveTvProvider } from './livetv-provider.js';
import { DisabledLiveTvProvider } from './disabled-livetv-provider.js';
// StandaloneLiveTvProvider is imported lazily to avoid pulling heavy
// dependencies (database, cache) into the SSR build bundle.

let instance: LiveTvProvider | null = null;
/** The settings `instance` was chosen for — a saved change re-decides. */
let instanceFor = '';

/**
 * Get the active LiveTV provider.
 * A singleton per LIVETV_SOURCE / STREAM_PROXY_URL: changing either in the
 * settings picks the provider again on the next call instead of keeping the
 * boot-time choice until a restart.
 */
export async function getLiveTvProvider(): Promise<LiveTvProvider> {
    const key = `${config.LIVETV_SOURCE}|${config.STREAM_PROXY_URL ? 'proxy' : ''}`;
    if (instance && instanceFor === key) {
        return instance;
    }
    instanceFor = key;

    const source = config.LIVETV_SOURCE;
    const parseResult = LiveTvSourceConfigSchema.safeParse(source);
    if (!parseResult.success) {
        logger.warn(`Invalid LIVETV_SOURCE value: "${source}". Falling back to disabled.`);
        instance = new DisabledLiveTvProvider();
        logger.info(`LiveTV provider initialized: disabled (effective: DisabledLiveTvProvider)`);
        return instance;
    }

    switch (parseResult.data) {
        case 'standalone': {
            if (!config.STREAM_PROXY_URL) {
                // LIVETV_SOURCE defaults to 'standalone' and STREAM_PROXY_URL is
                // unset on a fresh install — this branch is the NORMAL state for
                // an operator who hasn't turned Live TV on, not a misconfiguration,
                // and this factory runs on every call that needs a provider (not
                // just once at boot). Logging it as an error spammed the log on
                // every request for every install that has never touched Live TV.
                // Only escalate once the operator has explicitly enabled the
                // feature — config.ts's own startup validation already warns
                // about exactly that case (FEATURE_LIVETV + no proxy URL).
                if (config.FEATURE_LIVETV) {
                    logger.error(
                        'LIVETV_SOURCE=standalone but STREAM_PROXY_URL is not set — LiveTV disabled',
                    );
                } else {
                    logger.debug(
                        'LIVETV_SOURCE=standalone but STREAM_PROXY_URL is not set — LiveTV disabled (feature not enabled)',
                    );
                }
                instance = new DisabledLiveTvProvider();
            } else {
                const { StandaloneLiveTvProvider } =
                    await import('./standalone-livetv-provider.js');
                instance = new StandaloneLiveTvProvider();
            }
            break;
        }
        case 'disabled':
            instance = new DisabledLiveTvProvider();
            break;
        default:
            logger.error(`Unhandled LIVETV_SOURCE: ${source as string}`);
            instance = new DisabledLiveTvProvider();
            break;
    }

    logger.info(`LiveTV provider initialized: ${source} (effective: ${instance.constructor.name})`);
    return instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetLiveTvProvider(): void {
    instance = null;
    instanceFor = '';
}

export type { LiveTvProvider } from './livetv-provider.js';
export { matchEpgChannels } from './epg-matcher.js';
export type { EpgMatchResult, EpgMatch, EpgMatchSignal, UnmatchedChannel } from './epg-matcher.js';
export { validateXtreamCredentials, buildXtreamUrls } from './xtream-client.js';
export {
    validateHdHomeRunDevice,
    fetchHdHomeRunLineup,
    lineupToM3u,
    buildEpgUrl,
} from './hdhomerun-client.js';
export type { XtreamCredentials, XtreamValidationResult, XtreamUrls } from './xtream-client.js';
export type {
    HdHomeRunDeviceInfo,
    HdHomeRunChannel,
    HdHomeRunUrls,
    HdHomeRunValidationResult,
} from './hdhomerun-client.js';
export { importM3uSource, importEpgSource } from './livetv-import.service.js';
export type { ImportResult, ProgressCallback } from './livetv-import.service.js';
export { applySetupPreferences } from './livetv-setup.service.js';
export type { SetupPreferences, SetupResult } from './livetv-setup.service.js';
export { matchChannels, extractUrlChannelId } from './channel-matcher.js';
export type {
    ExistingChannel,
    ChannelMatch,
    ChannelMatchResult,
    MatchSignal,
    ConfidenceTier,
} from './channel-matcher.js';
export { refreshM3uSource, refreshEpgSource } from './livetv-refresh.service.js';
export type { RefreshResult } from './livetv-refresh.service.js';

export { probeLiveTvFeed } from './source-probe.js';
export { queueSourceImport } from './source-import-queue.js';

export { snapshotSourceChannelIdentities } from './channel-numbers.service.js';
export {
    snapshotSourceFavorites,
    carryOverSourceFavorites,
    type SourceFavoriteSnapshot,
} from './channel-favorites.service.js';
export { waitForSourceWriteLock } from './source-write-lock.js';
