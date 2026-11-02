// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
import type {
    FooterLink,
    SidebarLink,
    SidebarSection,
    UserMenuLink,
} from './routes/+layout.server';
import type { ResolvedIds } from './lib/server/services/media-id-resolver.types';
import type { UserContext } from './lib/server/types';
import type { ValidatedStreamingSession } from './lib/server/oauth/streaming-session.service';
import type { Principal } from './lib/server/api/principal';

interface AppBranding {
    appName?: string;
    appDescription?: string;
    logoSmall?: string;
    logoFull?: string;
    logoPlay?: string;
    backgroundImage?: string;
    /** Operator-supplied IMDb mark (RATING_LOGO_IMDB); empty when unset. */
    ratingLogoImdb?: string;
    /** Operator-supplied Rotten Tomatoes mark (RATING_LOGO_ROTTEN_TOMATOES); empty when unset. */
    ratingLogoRottenTomatoes?: string;
}

interface AppChatbotConfig {
    name?: string;
    avatar?: string;
    persona?: string;
    dailyLimitUser?: number;
    dailyLimitAdmin?: number;
}

interface AppFeatures {
    /** FEATURE_CLIENT_DIAGNOSTICS: the web client sends js_error / api_failures reports. */
    clientDiagnostics?: boolean;
    aiRecommendations?: boolean;
    aiAssistant?: boolean;
    liveTV?: boolean;
    audiobooks?: boolean;
    kavita?: boolean;
    calendar?: boolean;
    sessions?: boolean;
    internalPlayer?: boolean;
    watchTogether?: boolean;
    sidebar?: boolean;
    social?: boolean;
    socialReviews?: boolean;
    personalStats?: boolean;
    /** Per-user outbound notification webhook (FEATURE_USER_NOTIFICATION_WEBHOOKS) */
    userNotificationWebhooks?: boolean;
    sessionsPublic?: boolean;
    sessionsDeviceInfoPublic?: boolean;
    youtubeModals?: boolean;
    youtubeHero?: boolean;
    playerAutoQuality?: boolean;
    dockToggle?: boolean;
    requests?: boolean;
    playlists?: boolean;
    playlistChat?: boolean;
    starsBackground?: boolean;
    holidays?: boolean;
    trending?: boolean;
    deviceAuth?: boolean;
    userPats?: boolean;
    ffmpegAvailable?: boolean;
    quickConnect?: boolean;
    mediaHoverPopup?: boolean;
    mediaHoverPopupTrailers?: boolean;
    mediaHoverVideoPreview?: boolean;
    mediaHoverLiveTvPreview?: boolean;
    featuredPickVideo?: boolean;
    mediaAnnotations?: boolean;
    mediaChat?: boolean;
    avatarUpload?: boolean;
    /** Jellyfin server configured: JELLYFINURL and JELLYFINAPIKEY both set */
    jellyfin?: boolean;
    jellyfinCompat?: boolean;
    jellyfinSync?: boolean;
    subsonicCompat?: boolean;
    showUnairedEpisodes?: boolean;
    showMissingEpisodes?: boolean;
    /** Music Alchemy brew surface (FEATURE_MUSIC_ALCHEMY && FEATURE_MUSIC_CLUSTERING) */
    musicAlchemy?: boolean;
    /** Music-First mode redirect + sidebar reorder (FEATURE_MUSIC_FIRST) */
    musicFirst?: boolean;
    /** Sonic audio embeddings (FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS) — gates Song Paths */
    sonicEmbeddings?: boolean;
    /** 2D audio-embedding starfield at /music/map (FEATURE_MUSIC_MAP && sonicEmbeddings) */
    musicMap?: boolean;
    /** KMeans auto-playlists at /music/collections (FEATURE_MUSIC_CLUSTERS && sonicEmbeddings) */
    musicClusters?: boolean;
    /** Natural-language track search at /music/text-search (FEATURE_MUSIC_TEXT_SOUND && sonicEmbeddings) */
    textToSound?: boolean;
    /** Semantic lyrics kNN search at /music/lyrics-search (FEATURE_MUSIC_LYRICS_SEARCH && sonicEmbeddings) */
    lyricsSearch?: boolean;
    /**
     * Data-derived, not a config flag: Radio is "enabled" iff a station row exists.
     * Set explicitly by `+layout.server.ts`, so it never comes through the
     * config-key spread and has to be declared here by hand.
     */
    musicRadio?: boolean;
    /** Enterprise training assignments (config.trainingAssignments) */
    trainingAssignments?: boolean;
    /**
     * Admin-only: an enabled library of an uploadable type exists, so the
     * Library → Upload nav tab applies. Set by the admin `+layout.server.ts`.
     */
    libraryUpload?: boolean;
    /** Enterprise assessment — native quiz + certificate layer (config.assessment) */
    assessment?: boolean;
    /** Per-session video-preview gating on hover cards (config.videoPreviewSessionEnabled) */
    videoPreviewSessionEnabled?: boolean;
    /** Engagement re-ranking of the For You rails (config.forYouSectionRanker) */
    forYouSectionRanker?: boolean;
}

interface AppForYouConfig {
    defaultLimit?: number;
    sourcesLimit?: number;
    similarPerSource?: number;
    keywordRows?: number;
    keywordItems?: number;
    moodLimit?: number;
    secondBecauseSection?: boolean;
    secondBecauseLimit?: number;
}

interface AppHlsVodBufferSettings {
    maxBufferSize: number;
    maxBufferLength: number;
    maxMaxBufferLength: number;
    backBufferLength: number;
}

interface AppPlayerConfig {
    nextEpisodePromptLeadSeconds?: number;
    defaultQualityMode?: 'original' | 'auto';
    bufferTargetSeconds?: number;
    allowQualityOverride?: boolean;
    hlsVodBufferSettings?: AppHlsVodBufferSettings;
    subtitleSizeMultiplier?: number;
    subtitlePgsScale?: number;
    subtitleSrtScale?: number;
    /**
     * Shape of the volume slider's response. Served from PLAYER_VOLUME_CURVE
     * by +layout.server.ts and read by three players, but never declared here —
     * so every one of those reads was a type error that only `svelte-check`
     * could see. `tsgo` does not parse .svelte, so it stayed green.
     */
    volumeCurve?: 'linear' | 'quadratic' | 'quartic';
}

interface AppBrowseConfig {
    searchDebounceMs?: number;
    azPageSize?: number;
    keywordsInitial?: number;
    keywordsPageSize?: number;
    scrollMargin?: string;
}

/**
 * Browser-side tuning knobs forwarded from server config. Mirrors
 * `ClientTuning` in `$lib/stores/client-tuning`, which is what actually reads
 * them; the fields are optional because every consumer falls back to the
 * literal it used before it was wired.
 */
interface AppClientTuningConfig {
    partiesRefreshMs?: number;
    watchTogetherMaxReconnectMs?: number;
    playlistChatPollMs?: number;
    toastDefaultTimeoutMs?: number;
    playerSkipSeconds?: number;
    abrStabilityMs?: number;
    abrDownCooldownMs?: number;
    abrUpCooldownMs?: number;
    abrBandwidthSamples?: number;
    abrMinSamplesBeforeSwitch?: number;
    abrMinAdaptiveBitrate?: number;
    requestAvailableExpireHours?: number;
}

interface AppHomepageConfig {
    holidayLimit?: number;
}

interface AppTrendingConfig {
    dropdownGroups?: {
        groups: Array<{ id: string; label: string; listIds: string[] }>;
        hiddenLists: string[];
    };
    listNames?: Record<string, string>;
}

interface AppUserInfo {
    /** Stable users.id supplied by the root layout for the signed-in user. */
    userId?: string;
    username?: string;
    /** Credential-scoped admin verdict supplied by the root layout. */
    isAdmin?: boolean;
    hasRequestPermission?: boolean;
    hasReviewPermission?: boolean;
    hasMediaAnnotationPermission?: boolean;
    hasLiveTvPermission?: boolean;
    maxAgeRating?: number | null;
    isAgeRestricted?: boolean;
    /** Has moderation privileges: can delete any user content regardless of author */
    isModerator?: boolean;
    userGroups?: string[];
}

// Vite ?raw imports — used by src/lib/server/tasks/lua/loader.ts to embed
// .lua script sources at build time so the production bundle ships them
// alongside the loader chunk.
declare module '*?raw' {
    const src: string;
    export default src;
}

declare global {
    const __API_CONTRACT_STRICT__: boolean;
    /** Literal route segments (vite.diagnostic-route-words.ts); absent outside the app/test builds. */
    const __DIAGNOSTIC_ROUTE_WORDS__: string[] | undefined;
    // YouTube IFrame API types
    namespace YT {
        interface PlayerOptions {
            videoId?: string;
            width?: number | string;
            height?: number | string;
            playerVars?: PlayerVars;
            events?: PlayerEvents;
        }

        interface PlayerVars {
            autoplay?: 0 | 1;
            mute?: 0 | 1;
            controls?: 0 | 1;
            showinfo?: 0 | 1;
            rel?: 0 | 1;
            modestbranding?: 0 | 1;
            playsinline?: 0 | 1;
            start?: number;
            loop?: 0 | 1;
            playlist?: string;
        }

        interface PlayerEvents {
            onReady?: (event: PlayerEvent) => void;
            onStateChange?: (event: OnStateChangeEvent) => void;
            onError?: (event: OnErrorEvent) => void;
        }

        interface PlayerEvent {
            target: Player;
        }

        interface OnStateChangeEvent extends PlayerEvent {
            data: number;
        }

        interface OnErrorEvent extends PlayerEvent {
            data: number;
        }

        class Player {
            constructor(elementId: string | HTMLElement, options: PlayerOptions);
            playVideo(): void;
            pauseVideo(): void;
            stopVideo(): void;
            mute(): void;
            unMute(): void;
            isMuted(): boolean;
            setVolume(volume: number): void;
            getVolume(): number;
            getCurrentTime(): number;
            destroy(): void;
        }
    }

    interface Window {
        YT?: typeof YT;
        onYouTubeIframeAPIReady?: () => void;
    }

    namespace App {
        /**
         * Both `handleError` hooks (hooks.server.ts, hooks.client.ts) return an
         * `errorId` alongside the sanitized message: the raw error goes only to
         * the log, the id is the only thing that correlates a user's report with
         * that log line. Declared here so the error pages can read it without a
         * cast — while it was undeclared the field existed at runtime, was
         * invisible to the type system, and no page showed it.
         */
        interface Error {
            message: string;
            errorId?: string;
        }
        interface Locals {
            user: UserContext;
            /**
             * Normalized identity for the current request — populated by resolveAuth
             * (forward-auth.ts) for EVERY credential path (forward-auth, session, PAT,
             * service token, JWT, stream token). Used by enforce() in mount.ts.
             *
             * `undefined` only during the window before resolveAuth has run (i.e. before
             * hooks.server.ts calls it). All API route handlers can assume it is set.
             *
             * See: src/lib/server/api/principal.ts
             */
            principal?: Principal;
            /**
             * Jellyfin user UUID — set by stream tokens and forward-auth lazy resolver.
             * NOT set from JWT or PAT auth — routes must call resolveJellyfinUserId() on demand.
             */
            jellyfinUserId?: string;
            /** Unique device session ID from JWT - only present for Bearer token auth */
            deviceSessionId?: string;
            /** Stable, non-secret credential discriminator used by Live TV viewer accounting. */
            liveTvCredentialId?: string;
            /**
             * Device identity for a `/j` (Jellyfin compat) request, taken from the
             * session the token was minted against — NOT from the per-request
             * `X-Emby-Authorization` header, which is unvalidated and can drift from
             * the device the token is bound to.
             *
             * Only set on the session-auth branch. PAT-authenticated `/j` requests
             * leave this undefined and callers fall back to a synthetic per-user id.
             */
            jfDevice?: {
                /** Client-generated `DeviceId`. Opaque identity key, not display text. */
                deviceId: string | null;
                /** Client-reported device name, e.g. "Wohnzimmer". */
                deviceName: string | null;
                /** Client application, e.g. "Infuse" / "Streamyfin". */
                clientName: string | null;
                /** Client app version: per-request `Version` param, else the session's. */
                clientVersion: string | null;
            };
            /**
             * Authentication method used for this request:
             * - forward_auth: Authentik forward auth (browser users)
             * - session: Native (built-in) OR OIDC login session cookie (browser users)
             * - oidc: reserved — OIDC logins currently mint a method-agnostic session
             *   cookie and surface as 'session' at request time; this member is kept
             *   for future per-session auth-method tracking
             * - bearer: JWT access token (OAuth device flow)
             * - pat: Personal Access Token (user-created API keys)
             * - service_token: Service Token (admin-created API keys)
             * - stream_token: Streaming session token (HLS playback)
             * - jellyfin_compat_session: Jellyfin compat session token (Valkey-backed)
             * - jellyfin_compat_pat: Jellyfin compat PAT (scopes=['jellyfin_compat'])
             */
            authMethod?:
                | 'forward_auth'
                | 'session'
                | 'oidc'
                | 'bearer'
                | 'pat'
                | 'service_token'
                | 'stream_token'
                | 'jellyfin_compat_session'
                | 'jellyfin_compat_pat';
            /** Streaming session info - only present for stream_token auth */
            streamingSession?: ValidatedStreamingSession;
            /** Raw access token - only present for token auth, used for HLS URL rewriting */
            accessToken?: string;
            /**
             * Raw Authentik group header list for THIS request — the IdP projection
             * only, before the in-app group-name merge (`resolveInAppAccess`) that
             * feeds `user.userGroups`. Set only on the `forward_auth` path, beside
             * `authMethod`. A writer of `users.groups` must persist THIS list, not
             * `user.userGroups` (security review 6, P2): the merged set bakes in-app
             * group names into the column every token path reads as the IdP
             * projection, so removing a user from an in-app library/admin group
             * never reaches those surfaces. Not added to `UserContext` (~400
             * consumers) — only the one writer (`POST /api/oauth/authorize`) needs it.
             *
             * `undefined` when the groups header was ABSENT (no IdP statement —
             * never write); `[]` when it was present and empty (the IdP revoked
             * every group — write it, clearing the column).
             */
            idpGroups?: string[];

            /**
             * Resolved media IDs (injected by withIdResolution middleware)
             */
            resolvedIds?: ResolvedIds;

            /**
             * Parsed POST body params for Subsonic compat routes.
             * Set by the Subsonic dispatcher when Content-Type is form-urlencoded.
             */
            subsonicBodyParams?: URLSearchParams;
        }
        interface PageData {
            /** Configured metadata sources credited in About (never credentials). */
            metadataAttributionProviders?: string[];
            user?: AppUserInfo;
            /** Auth method for the current request (e.g. 'session', 'forward_auth'). */
            authMethod?: string;
            adminGroups?: string[];
            watchPermissionGroups?: string[];
            arrManagerGroups?: string[];
            liveTvGroups?: string[];
            requestGroups?: string[];
            socialReviewGroups?: string[];
            mediaAnnotationGroups?: string[];
            navigationAvailableGroups?: string[];
            /** Legacy root-layout config is comma-separated; anonymous data uses an empty list. */
            playlistPublicGroups?: string | string[];
            branding?: AppBranding;
            /** WEB_APP_INSTALL_HINT — show the iPhone/iPad "Get the app" hint. */
            appInstallHint?: boolean;
            chatbot?: AppChatbotConfig;
            features?: AppFeatures;
            /** Server primary metadata language, followed by additional metadata languages. */
            mediaLanguagePriority?: string[];
            /** Instance primary content mode. Default 'vod'. */
            primaryMode?: 'vod' | 'music' | 'mixed' | 'enterprise' | 'showcase';
            forYou?: AppForYouConfig;
            player?: AppPlayerConfig;
            browse?: AppBrowseConfig;
            clientTuning?: AppClientTuningConfig;
            homepage?: AppHomepageConfig;
            trending?: AppTrendingConfig;
            userMenuLinks?: UserMenuLink[];
            footerLinks?: FooterLink[];
            sidebarLinks?: SidebarLink[];
            sidebarSections?: SidebarSection[];
            quickConnect?: boolean;
            serviceUrls?: {
                jellyfin: string;
                sonarr: string;
                radarr: string;
                jellyseerr: string;
            };
            [key: string]: unknown;
        }
        /**
         * Shallow-routing page state (SvelteKit `pushState`/`replaceState`).
         * Admin IA redesign, spec §6: the shared `DetailPanel` shell is
         * URL-backed via `openDetail()`/`closeDetail()`
         * (`$lib/components/admin/detail/detail-url.ts`) — opening a detail
         * item from a list pushes the item's own URL onto history without a
         * full navigation, and stamps this marker so the hosting list page
         * knows to render the panel. On a real navigation / page reload,
         * `page.state` is always `{}` (SvelteKit's shallow-routing contract),
         * so the item's OWN route renders instead — that's what gives every
         * DetailPanel its "direct link = same content as a full page" mode.
         */
        interface PageState {
            /** Parent URL for a shallow media-detail history entry. */
            modalPreviousUrl?: string;
            musicPreviewUrl?: string;
            musicPlaylistOrigin?: boolean;
            musicPreviewPushed?: boolean;
            detailPanel?: { path: string };
            /** Reactive query state for shallow admin workspace navigation. */
            adminWorkspaceUrl?: string;
        }
        // interface Platform {}
    }
}

export {};
