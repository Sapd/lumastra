// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { JELLYFIN_EMULATED_VERSION, JELLYFIN_SERVER_ID } from '../constants';
import type { JellyfinPublicSystemInfo, JellyfinBrandingOptions } from '../types';

export function getPublicSystemInfo(requestUrl?: string): JellyfinPublicSystemInfo {
    return {
        LocalAddress: requestUrl || '',
        ServerName: 'Jellyfin',
        Version: JELLYFIN_EMULATED_VERSION,
        Id: JELLYFIN_SERVER_ID,
        StartupWizardCompleted: true,
        OperatingSystem: 'Linux',
        ProductName: 'Jellyfin Server',
    };
}

export function getBrandingOptions(): JellyfinBrandingOptions {
    return {
        LoginDisclaimer: '',
        CustomCss: '',
        SplashscreenEnabled: false,
    };
}

/**
 * GET /Branding/Css and /Branding/Css.css: the server's custom CSS as
 * `text/css`. Lumastra has no custom CSS for Jellyfin's web UI, so this is the
 * empty stylesheet — the same text `/Branding/Configuration` reports as
 * `CustomCss`. Anonymous, as in Jellyfin (the login page loads it).
 */
export function brandingCssResponse(): Response {
    return new Response(getBrandingOptions().CustomCss, {
        headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
        },
    });
}
