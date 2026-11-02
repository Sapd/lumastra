// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config, features, BACKEND_ONLY_FEATURES } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { isModuleLicensed } from '$lib/server/licensing/feature-gate.js';
import { isRadioConfigured } from '$lib/server/services/music/radio-configured.service.js';

export interface ServerBranding {
    appName: string;
    appDescription: string;
    logoSmall: string;
    logoFull: string;
    logoPlay: string;
    backgroundImage: string;
    ratingLogoImdb: string;
    ratingLogoRottenTomatoes: string;
}

/** Shared branding for SSR and server discovery, with the same license gate. */
export async function getServerBranding(): Promise<ServerBranding> {
    if (!(await isModuleLicensed('branding_removal'))) {
        return {
            appName: 'Lumastra',
            appDescription: 'Media Dashboard',
            logoSmall: '',
            logoFull: '',
            logoPlay: '',
            backgroundImage: '',
            ratingLogoImdb: '',
            ratingLogoRottenTomatoes: '',
        };
    }
    return {
        appName: config.APP_NAME,
        appDescription: config.APP_DESCRIPTION,
        logoSmall: config.APP_LOGO_SMALL,
        logoFull: config.APP_LOGO_FULL,
        logoPlay: config.APP_LOGO_PLAY,
        backgroundImage: config.APP_BACKGROUND_IMAGE,
        ratingLogoImdb: config.RATING_LOGO_IMDB,
        ratingLogoRottenTomatoes: config.RATING_LOGO_ROTTEN_TOMATOES,
    };
}

const featureCache = new Map<
    string,
    { expiresAt: number; value: Promise<Record<string, boolean>> }
>();

export function _resetServerFeaturesCache(): void {
    featureCache.clear();
}

/** The feature matrix is private; licensing changes appear within five seconds. */
export function getServerFeatures(
    kind: 'web' | 'discovery' = 'web',
): Promise<Record<string, boolean>> {
    const now = Date.now();
    const cached = featureCache.get(kind);
    if (cached && cached.expiresAt > now) return cached.value;
    const value: Promise<Record<string, boolean>> = computeServerFeatures().catch((error: unknown) => {
        if (featureCache.get(kind)?.value === value) featureCache.delete(kind);
        throw error;
    });
    featureCache.set(kind, { expiresAt: now + 3_000, value });
    return value;
}

async function computeServerFeatures(): Promise<Record<string, boolean>> {
    const sql = getDb();
    const [aiAssistantLicensed, musicRadio] = await Promise.all([
        isModuleLicensed('ai_assistant'),
        sql ? isRadioConfigured(sql) : Promise.resolve(false),
    ]);
    return {
        ...Object.fromEntries(
            Object.keys(features)
                .filter((key) => !BACKEND_ONLY_FEATURES.has(key))
                .map((key) => [key, features[key as keyof typeof features]]),
        ),
        videoPreviews: config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW,
        topShelfPreviews: config.FEATURE_TOPSHELF_PREVIEWS,
        topShelfOverlay: config.FEATURE_TOPSHELF_PREVIEWS,
        mediaDownload: config.FEATURE_MEDIA_DOWNLOAD,
        downloadRenditions: config.FEATURE_DOWNLOAD_RENDITIONS,
        seriesSmartDownloads: config.FEATURE_DOWNLOAD_RENDITIONS,
        musicRadio,
        aiAssistant: features.aiAssistant && aiAssistantLicensed,
    };
}
