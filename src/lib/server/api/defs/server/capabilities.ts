// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '$lib/server/utils/logger.js';
import { getInitialScanStatus } from '$lib/server/services/initial-scan-status.service.js';
import { features, config } from '$lib/server/config.js';
import { normalizeLanguageTag } from '$lib/shared/metadata-language.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { LIVETV_RUNGS } from '$lib/shared/livetv-rungs.js';
import { EVENT_KINDS } from '$lib/server/api/event-kinds.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { getDb } from '$lib/server/database/connection.js';
import { getActiveLibraryTypes } from '$lib/server/database/queries/library-types.queries.js';
import { getEffectiveEntitlements } from '$lib/server/licensing/entitlements.js';
import { hasUsablePushCredential } from '$lib/server/services/push/push-transport-selector.js';

import { getServerFeatures } from '$lib/server/server-branding.js';
import { ServerFeaturesSchema } from '$lib/schemas/server-info.js';
import type { InitialScanStatus, ServerCapabilities } from '$lib/schemas/server-info.js';

const logger = Logger.for('Server:Capabilities');

/** A scan hint must never take playback or the rest of discovery down. */
async function libraryScanCapability(
    isAdmin: boolean,
): Promise<NonNullable<ServerCapabilities['library']>> {
    let status: InitialScanStatus;
    try {
        status = await getInitialScanStatus();
    } catch (error) {
        logger.warn(
            'Initial scan status unavailable; retaining other server capabilities',
            error instanceof Error ? error : undefined,
        );
        status = { initialScanRunning: false, itemsSoFar: 0 };
    }
    // Project per credential, without mutating the shared five-second cache.
    return isAdmin ? status : { initialScanRunning: status.initialScanRunning };
}

interface AdvertisedEventKind {
    name: string;
    class: 'notification' | 'signal';
    durable: boolean;
    available: boolean;
    unavailableReason?: string;
}

/**
 * Per-install availability for each kind in `EVENT_KINDS`. Everything is
 * available except `request.available`, which needs Jellyseerr configured —
 * this is the "understands the kind" vs "can arrive here" split
 * (docs/architecture/user-events.md, "Client contract"). Computed per
 * request: `jellyseerrClient.isConfigured()` can flip at runtime (a failed
 * connection latches `connectionFailed`), so this is not a value that can be
 * baked in once at module load.
 */
export function eventKinds(): AdvertisedEventKind[] {
    return EVENT_KINDS.map((kind) => {
        if (kind.name === 'request.available' && !jellyseerrClient.isConfigured()) {
            return { ...kind, available: false, unavailableReason: 'requests_not_configured' };
        }
        return { ...kind, available: true };
    });
}

// Bare fallback matching the TMDB_LANGUAGE getter's own default ('en-US') in
// config.ts — used only when the stored setting is empty or unnormalizable,
// so this endpoint never advertises a nonsensical `metadata.primary: ""`.
// The admin settings key has no `minLength` guard and the ConfigService path
// returns a stored `""` verbatim, so an empty TMDB_LANGUAGE is reachable here
// even though the config getter's own default is 'en-US'. Consistent with
// `primaryTags()` in metadata-language-resolve.ts, which treats an empty
// TMDB_LANGUAGE as "no primary" rather than deriving a tag from it.
const DEFAULT_METADATA_PRIMARY = 'en';

/** Enabled metadata languages. Mirrors settings/display/+page.server.ts. */
export function metadataLanguages(): { primary: string; additional: string[] } {
    const primaryBare = config.TMDB_LANGUAGE ? config.TMDB_LANGUAGE.split('-')[0] : '';
    const primary =
        (primaryBare ? normalizeLanguageTag(primaryBare) : null) ?? DEFAULT_METADATA_PRIMARY;
    return {
        primary,
        additional: config.METADATA_ADDITIONAL_LANGUAGES,
    };
}

/**
 * Whether at least one enabled music library exists. `features.music` used to
 * alias `FEATURE_MUSIC_CLUSTERING` (the Quick Picks taste-clustering toggle) —
 * a misleading name for a capability field, since it answered "is clustering
 * on" rather than "does this server have music at all". The clustering signal
 * now lives at `music.clustering`; `music.available` reports library presence,
 * mirroring the `activeLibraryTypes.includes('music')` check the web app's
 * own sidebar/settings UI already uses (see DataResetSection.svelte).
 * Errors default to `false` — a DB hiccup shouldn't fail the whole
 * capabilities response.
 */
export async function hasMusicLibrary(): Promise<boolean> {
    try {
        const sql = getDb();
        if (!sql) return false;
        const types = await getActiveLibraryTypes(sql);
        return types.includes('music');
    } catch {
        return false;
    }
}

/**
 * Whether this install can deliver APNs push, in check order feature flag →
 * device auth → entitlement → push credential. Registration rides the device
 * routes (`FEATURE_DEVICE_AUTH`), so that flag gates availability even when the
 * push feature flag itself is on. Entitlement is gated on
 * `modules.has('push')`, never on `edition` — see the licensing module
 * comment on `LicenseModule`.
 *
 * The credential check is last and is not optional. Entitlement and credential
 * are different facts that disagree in the common case: with licence
 * enforcement off — the default in every build shipped so far — the entitlement
 * resolver returns `UNLIMITED_ENTITLEMENTS`, which contains `'push'`, while the
 * licence refresh that mints the relay token never runs. An install in that
 * state would answer `available: true` and then fail every single delivery.
 * This endpoint exists precisely so the iOS client does not burn the one
 * notification-permission prompt iOS grants on an install that cannot deliver,
 * so a capability that ignores the credential defeats its own purpose.
 *
 * `hasUsablePushCredential()` covers BOTH routes: an operator's own Apple
 * signing key (`DirectApnsTransport`) as well as a relay credential. It asks
 * the transport selector which one this install will actually use and checks
 * that one, rather than "does any credential exist" — a broken `.p8` alongside
 * a working relay token still delivers nothing, because the selector routes to
 * the direct transport.
 */
export async function computePushCapability(): Promise<{
    available: boolean;
    unavailableReason?:
        'feature_disabled' | 'device_auth_disabled' | 'not_entitled' | 'no_relay_credential';
}> {
    if (!config.FEATURE_PUSH_NOTIFICATIONS) {
        return { available: false, unavailableReason: 'feature_disabled' };
    }
    if (!config.FEATURE_DEVICE_AUTH) {
        // Registration hangs off the device routes, which that flag gates.
        return { available: false, unavailableReason: 'device_auth_disabled' };
    }
    const entitlements = await getEffectiveEntitlements();
    if (!entitlements.modules.has('push')) {
        return { available: false, unavailableReason: 'not_entitled' };
    }
    if (!hasUsablePushCredential()) {
        // 🔴 `no_relay_credential` now means "no usable push credential of any
        // kind", relay OR operator-supplied Apple key. The name is narrower
        // than the meaning and is kept that way DELIBERATELY: the iOS client
        // froze this enum against exactly four values, decodes it strictly, and
        // a fifth (or a rename) breaks the decode of the whole capabilities
        // response — taking playback, transcoder and event advertisement down
        // with it. A misleading-but-stable string beats an accurate one that
        // bricks shipped clients; the reason is diagnostic text, not a
        // behavioural switch, and every value of it leads the operator to the
        // same place (configure a credential).
        return { available: false, unavailableReason: 'no_relay_credential' };
    }
    return { available: true };
}

export async function buildServerCapabilities(
    surface: 'internal' | 'v1',
    isAdmin = false,
): Promise<ServerCapabilities> {
    const ffmpeg = features.ffmpegAvailable;
    const webFeatures = await getServerFeatures('discovery');
    return {
        library: await libraryScanCapability(isAdmin),
        playback: {
            direct: true,
            remux: ffmpeg,
            transcode: ffmpeg,
            transcoder: {
                engine: 'ffmpeg',
                videoCodecs: ['h264', 'hevc', 'av1'],
                audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'flac', 'opus'],
                containers: ['mp4', 'mkv', 'ts'],
                maxResolution: '4K',
                hdrPassthrough: true,
                dolbyVisionPassthrough: false,
            },
            hlsVariants: ffmpeg ? ['360p', '480p', '720p', '1080p', '4K'] : [],
            maxBitrateKbps: null,
        },
        liveTv: {
            available: features.liveTV,
            adaptiveLadder: {
                enabled: config.LIVETV_ADAPTIVE_LADDER_ENABLED,
                defaultQuality: config.LIVETV_ADAPTIVE_LADDER_ENABLED
                    ? config.LIVETV_DEFAULT_QUALITY
                    : 'original',
                includeOriginalExperimental:
                    config.LIVETV_ADAPTIVE_LADDER_ENABLED &&
                    config.LIVETV_ADAPTIVE_INCLUDE_ORIGINAL,
                rungs: LIVETV_RUNGS.map((rung) => ({
                    id: rung.id,
                    height: rung.height,
                    maxBitrateBps: rung.maxBitrate,
                    codec: rung.codec,
                })),
            },
        },
        music: {
            available: await hasMusicLibrary(),
            clustering: features.musicClustering,
            sonicSimilarity: features.sonicEmbeddings,
            sonicMixes: features.musicClusters,
        },
        audiobooks: { available: features.audiobooks },
        features: ServerFeaturesSchema.parse({
            ...Object.fromEntries(
                Object.keys(ServerFeaturesSchema.shape).map((key) => [
                    key,
                    webFeatures[key] ?? false,
                ]),
            ),
            aiRecommendations: features.aiRecommendations,
            aiAssistant: webFeatures.aiAssistant ?? false,
            watchTogether: features.watchTogether,
            social: features.social,
            videoPreviews: config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW,
            topShelfPreviews: config.FEATURE_TOPSHELF_PREVIEWS,
            topShelfOverlay: config.FEATURE_TOPSHELF_PREVIEWS,
            mediaDownload: config.FEATURE_MEDIA_DOWNLOAD,
            downloadRenditions: config.FEATURE_DOWNLOAD_RENDITIONS,
            seriesSmartDownloads: config.FEATURE_DOWNLOAD_RENDITIONS,
        }),
        integrations: { requests: { available: jellyseerrClient.isConfigured() } },
        push: await computePushCapability(),
        events: {
            href: apiUrl(surface, '/events'),
            reconnectMaxMs: 30_000,
            kinds: eventKinds(),
        },
        metadata: metadataLanguages(),
    };
}
