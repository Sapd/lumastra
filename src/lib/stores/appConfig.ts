// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App Configuration Store
 *
 * Loads branding and feature flags from the server and caches them.
 * Use this store to check feature availability and get branding info.
 */

import { writable, derived, get } from 'svelte/store';

interface AppConfig {
    branding: { appName: string; appDescription: string };
    features: Record<string, boolean>;
}

// Default config (used before server response) - safe-by-default (all features false)
const defaultConfig: AppConfig = {
    branding: {
        appName: 'Lumastra',
        appDescription: 'Media Dashboard',
    },
    features: {
        aiRecommendations: false,
        aiAssistant: false,
        liveTV: false,
        audiobooks: false,
        calendar: false,
        sessions: false,
        internalPlayer: true,
        watchTogether: false,
        sidebar: false,
        youtubeModals: false,
        youtubeHero: false,
        quickConnect: false,
        requests: false,
        kavita: false,
        social: false,
        personalStats: false,
        sessionsPublic: false,
        sessionsDeviceInfoPublic: false,
        playerAutoQuality: false,
        dockToggle: false,
        playlists: false,
        mediaHoverPopup: false,
        mediaHoverPopupTrailers: false,
        mediaHoverVideoPreview: false,
        mediaHoverLiveTvPreview: false,
        featuredPickVideo: false,
        playlistChat: false,
        starsBackground: false,
        trending: false,
        deviceAuth: false,
        userPats: false,
        ffmpegAvailable: false,
        jellyfin: false,
        musicAlchemy: false,
        musicFirst: false,
    },
};

// Main config store
const configStore = writable<AppConfig>(defaultConfig);
const loadedStore = writable(false);
/**
 * Hydrate the config store from server-provided page data (branding + features).
 *
 * Called reactively from the root layout with its SSR branding and feature matrix.
 * Values merge over safe defaults, including the empty anonymous feature map.
 */
export function hydrateAppConfig(
    data:
        | {
              branding?: Partial<AppConfig['branding']>;
              /**
               * The layout's SSR feature matrix is `AppFeatures` — a set of named
               * optional booleans, NOT a `Record<string, boolean>`. Accepting the
               * record shape here meant the real argument only fitted while its type
               * was the degenerate `{}`; naming the actual type is what lets the
               * caller pass `data` directly. The spread below still tolerates keys
               * `AppConfig` does not know about.
               */
              features?: App.PageData['features'];
          }
        | null
        | undefined,
): void {
    if (!data) return;
    configStore.set({
        branding: { ...defaultConfig.branding, ...(data.branding ?? {}) },
        features: {
            ...defaultConfig.features,
            ...(data.features ?? {}),
        } as AppConfig['features'],
    });
    loadedStore.set(true);
}

// Derived stores for easy access
export const appConfig = { subscribe: configStore.subscribe };
export const configLoaded = { subscribe: loadedStore.subscribe };

// Convenience derived stores
export const appName = derived(configStore, ($config) => $config.branding.appName);
export const appDescription = derived(configStore, ($config) => $config.branding.appDescription);

// Feature flags as individual stores for reactive checks
export const featureAI = derived(configStore, ($config) => $config.features.aiRecommendations);
export const featureAiAssistant = derived(configStore, ($config) => $config.features.aiAssistant);
export const featureLiveTV = derived(configStore, ($config) => $config.features.liveTV);
export const featureAudiobooks = derived(configStore, ($config) => $config.features.audiobooks);
export const featureCalendar = derived(configStore, ($config) => $config.features.calendar);
export const featureSessions = derived(configStore, ($config) => $config.features.sessions);
export const featureWatchTogether = derived(
    configStore,
    ($config) => $config.features.watchTogether,
);
export const featureSidebar = derived(configStore, ($config) => $config.features.sidebar);
export const featureYoutubeModals = derived(
    configStore,
    ($config) => $config.features.youtubeModals,
);
export const featureYoutubeHero = derived(configStore, ($config) => $config.features.youtubeHero);
export const featureQuickConnect = derived(configStore, ($config) => $config.features.quickConnect);
export const featureRequests = derived(configStore, ($config) => $config.features.requests);

// Helper to check feature availability synchronously (after config is loaded)
export function isFeatureEnabled(feature: keyof AppConfig['features']): boolean {
    return get(configStore).features[feature];
}

// Helper to get branding synchronously
export function getBranding(): AppConfig['branding'] {
    return get(configStore).branding;
}
