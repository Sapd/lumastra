// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { CLIENT_VERSION_PATTERN } from '$lib/shared/client-version.js';

const BrandingSchema = z.object({ appName: z.string(), appDescription: z.string() }).strict();
const AuthSchema = z
    .object({
        deviceFlow: z
            .object({
                enabled: z.boolean(),
                deviceAuthorizationHref: z.string(),
                tokenHref: z.string(),
            })
            .strict(),
        passwordLogin: z.object({ enabled: z.boolean() }).strict(),
    })
    .strict();

export const ServerFeaturesSchema = z
    .object({
        aiRecommendations: z.boolean(),
        aiAssistant: z.boolean(),
        kavita: z.boolean(),
        calendar: z.boolean(),
        sessions: z.boolean(),
        internalPlayer: z.boolean(),
        watchTogether: z.boolean(),
        sidebar: z.boolean(),
        social: z.boolean(),
        socialReviews: z.boolean(),
        comments: z.boolean(),
        personalStats: z.boolean(),
        avatarUpload: z.boolean(),
        gravatar: z.boolean(),
        autoLyrics: z.boolean(),
        clientDiagnostics: z.boolean(),
        clientLogBundles: z.boolean(),
        clientDiagnosticsLogTail: z.boolean(),
        saveLyricsToDisk: z.boolean(),
        musicLyricsFetch: z.boolean(),
        sessionsPublic: z.boolean(),
        showUnairedEpisodes: z.boolean(),
        showMissingEpisodes: z.boolean(),
        sessionsDeviceInfoPublic: z.boolean(),
        youtubeModals: z.boolean(),
        youtubeHero: z.boolean(),
        userNotificationWebhooks: z.boolean(),
        quickConnect: z.boolean(),
        playerAutoQuality: z.boolean(),
        dockToggle: z.boolean(),
        requests: z.boolean(),
        requestsConfigured: z.boolean(),
        playlists: z.boolean(),
        mediaHoverPopup: z.boolean(),
        mediaHoverPopupTrailers: z.boolean(),
        mediaHoverVideoPreview: z.boolean(),
        videoPreviewSessionEnabled: z.boolean(),
        mediaHoverLiveTvPreview: z.boolean(),
        featuredPickVideo: z.boolean(),
        playlistChat: z.boolean(),
        mediaAnnotations: z.boolean(),
        mediaChat: z.boolean(),
        starsBackground: z.boolean(),
        trending: z.boolean(),
        holidays: z.boolean(),
        userPats: z.boolean(),
        jellyfin: z.boolean(),
        jellyfinSync: z.boolean(),
        jellyfinCompat: z.boolean(),
        subsonicCompat: z.boolean(),
        unratedContentVisible: z.boolean(),
        musicTranscode: z.boolean(),
        forYouAbandonmentDemote: z.boolean(),
        forYouSectionRanker: z.boolean(),
        musicAlchemy: z.boolean(),
        musicFirst: z.boolean(),
        sonicEmbeddings: z.boolean(),
        musicMap: z.boolean(),
        lyricsSearch: z.boolean(),
        musicClusters: z.boolean(),
        textToSound: z.boolean(),
        sonicTaste: z.boolean(),
        sonicQueue: z.boolean(),
        trainingAssignments: z.boolean(),
        assessment: z.boolean(),
        musicRadio: z.boolean(),
        videoPreviews: z.boolean(),
        topShelfPreviews: z.boolean(),
        topShelfOverlay: z.boolean(),
        mediaDownload: z.boolean(),
        downloadRenditions: z.boolean(),
        seriesSmartDownloads: z.boolean(),
    })
    .strict();

export const InitialScanStatusSchema = z.object({
    initialScanRunning: z
        .boolean()
        .describe('An initial filesystem scan is active for at least one library path.'),
    itemsSoFar: z
        .number()
        .int()
        .nonnegative()
        .describe(
            'Administrators only: files processed so far across active initial scans, not a library item count or percentage. Zero during discovery and when idle.',
        ),
});
export type InitialScanStatus = z.infer<typeof InitialScanStatusSchema>;

export const ServerCapabilitiesSchema = z.object({
    library: InitialScanStatusSchema.partial({ itemsSoFar: true })
        .optional()
        .describe(
            'Initial filesystem scan state, cached for up to five seconds. Only present for signed-in callers.',
        ),
    playback: z.object({
        direct: z.boolean(),
        remux: z.boolean(),
        transcode: z.boolean(),
        transcoder: z.object({
            engine: z.string(),
            videoCodecs: z.array(z.string()),
            audioCodecs: z.array(z.string()),
            containers: z.array(z.string()),
            maxResolution: z.string(),
            hdrPassthrough: z.boolean(),
            dolbyVisionPassthrough: z.boolean(),
        }),
        hlsVariants: z.array(z.string()),
        maxBitrateKbps: z.number().nullable(),
    }),
    liveTv: z.object({
        available: z.boolean(),
        adaptiveLadder: z.object({
            enabled: z.boolean(),
            defaultQuality: z.enum([
                'adaptive',
                'original',
                '1080p8m',
                '720p4m',
                '540p2m',
                '360p1m',
            ]),
            includeOriginalExperimental: z.boolean(),
            rungs: z.array(
                z.object({
                    id: z.string(),
                    height: z.number().int().positive(),
                    maxBitrateBps: z.number().int().positive(),
                    codec: z.literal('h264'),
                }),
            ),
        }),
    }),
    music: z.object({
        available: z.boolean(),
        clustering: z.boolean(),
        sonicSimilarity: z
            .boolean()
            .describe(
                'Audio-embedding similarity: `basis=sonic` on GET /music/tracks/{id}/similar and the album/artist `/similar` routes.',
            ),
        sonicMixes: z
            .boolean()
            .describe(
                'Library-wide sonic mixes: GET /music/sonic-mixes and /music/sonic-mixes/{id}/tracks.',
            ),
    }),
    audiobooks: z.object({ available: z.boolean() }),
    features: ServerFeaturesSchema,
    integrations: z.object({ requests: z.object({ available: z.boolean() }) }),
    push: z.object({
        available: z.boolean(),
        unavailableReason: z
            .enum([
                'feature_disabled',
                'device_auth_disabled',
                'not_entitled',
                'no_relay_credential',
            ])
            .optional(),
    }),
    events: z.object({
        href: z.string(),
        reconnectMaxMs: z.number(),
        kinds: z.array(
            z.object({
                name: z.string(),
                class: z.enum(['notification', 'signal']),
                durable: z.boolean(),
                available: z.boolean(),
                unavailableReason: z.string().optional(),
            }),
        ),
    }),
    metadata: z.object({ primary: z.string(), additional: z.array(z.string()) }),
});

/**
 * The caller's permission flags: ONE name per permission, used by `GET /server`
 * (`caller.permissions`) and `GET /me` (`permissions`). Playback needs no flag,
 * only library access.
 */
export const CallerPermissionsSchema = z
    .object({
        canRequest: z.boolean().describe('May request media that is not in the library.'),
        canReview: z.boolean().describe('May write community reviews.'),
        canAnnotateMedia: z.boolean().describe('May view and create player annotations.'),
        canWatchLiveTv: z
            .boolean()
            .describe('May use Live TV; without it every Live TV endpoint answers 403.'),
        canSeeAllPlayback: z
            .boolean()
            .describe(
                "Active-streams views show everyone's playback, not only the caller's. GET /play-sessions?scope=all still requires an administrator.",
            ),
    })
    .meta({ id: 'CallerPermissions' });
export type CallerPermissions = z.infer<typeof CallerPermissionsSchema>;

/** The permission flags of a resolved user (absent user: all false). */
export function callerPermissions(
    user:
        | {
              hasRequestPermission?: boolean;
              hasReviewPermission?: boolean;
              hasMediaAnnotationPermission?: boolean;
              hasLiveTvPermission?: boolean;
              hasWatchPermission?: boolean;
          }
        | undefined,
): CallerPermissions {
    return {
        canRequest: user?.hasRequestPermission ?? false,
        canReview: user?.hasReviewPermission ?? false,
        canAnnotateMedia: user?.hasMediaAnnotationPermission ?? false,
        canWatchLiveTv: user?.hasLiveTvPermission ?? false,
        canSeeAllPlayback: user?.hasWatchPermission ?? false,
    };
}

export const CallerSchema = z.object({
    id: z.string().describe('Opaque user identifier supplied by the authenticated principal'),
    isAdmin: z.boolean(),
    permissions: CallerPermissionsSchema,
});

const common = {
    id: z.string().uuid(),
    name: z.string(),
    release: z.string(),
    apiVersions: z.array(z.literal('v1')),
    minClientVersion: z
        .object({
            ios: z.string().regex(new RegExp(CLIENT_VERSION_PATTERN)).optional(),
            tvos: z.string().regex(new RegExp(CLIENT_VERSION_PATTERN)).optional(),
            web: z.string().regex(new RegExp(CLIENT_VERSION_PATTERN)).optional(),
            other: z.string().regex(new RegExp(CLIENT_VERSION_PATTERN)).optional(),
        })
        .nullable()
        .optional()
        .describe(
            'Minimum supported SemVer by platform, available before sign-in. Null or an absent platform means no minimum. Configured by MIN_CLIENT_VERSION_IOS/TVOS/WEB/OTHER; all default to empty (null).',
        ),
    branding: BrandingSchema,
    auth: AuthSchema,
};

export const AnonymousServerInfoSchema = z
    .object({
        ...common,
        links: z.object({ self: z.string() }).strict(),
        caller: z.null(),
    })
    .strict();
export const AuthenticatedServerInfoSchema = z
    .object({
        ...common,
        links: z
            .object({
                self: z.string(),
                me: z.string(),
                events: z.string(),
                notice: z.string(),
            })
            .strict(),
        caller: CallerSchema,
        build: z.string(),
        capabilities: ServerCapabilitiesSchema,
    })
    .strict();
export const ServerInfoSchema = z.union([AnonymousServerInfoSchema, AuthenticatedServerInfoSchema]);
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
