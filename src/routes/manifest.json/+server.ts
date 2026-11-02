// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dynamic manifest.json route
 * Generates PWA manifest with correct base path for subfolder deployment
 */

import { json } from '@sveltejs/kit';
import { base } from '$app/paths';
import { config } from '$lib/server/config';
import type { RequestHandler } from './$types';

// Helper to prefix path with base
function withBase(path: string): string {
    if (!base) return path;
    return `${base}${path}`;
}

export const GET: RequestHandler = async () => {
    // Brandable identity. Mirrors the navbar/shell branding so the installed PWA
    // (name on the home screen, splash colors) matches an operator's APP_* config
    // instead of always installing as "Lumastra". The icon `src` paths stay fixed
    // — operators override the bundled PNGs by mounting their own over
    // /app/build/client/icon-*.png (see lumastra.org/reference/environment-variables/).
    const manifest = {
        name: config.APP_NAME,
        short_name: config.APP_NAME,
        description: config.APP_DESCRIPTION,
        start_url: withBase('/'),
        display: 'standalone',
        background_color: config.APP_BACKGROUND_COLOR,
        theme_color: config.APP_THEME_COLOR,
        orientation: 'any',
        scope: base || '/',
        id: base || '/',
        categories: ['entertainment', 'video'],
        icons: [
            {
                src: withBase('/icon-192.png'),
                sizes: '192x192',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: withBase('/icon-512.png'),
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any',
            },
            {
                src: withBase('/icon-192-maskable.png'),
                sizes: '192x192',
                type: 'image/png',
                purpose: 'maskable',
            },
            {
                src: withBase('/icon-512-maskable.png'),
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
            },
        ],
        shortcuts: [
            {
                name: 'Browse',
                short_name: 'Browse',
                description: 'Browse all movies and TV shows',
                url: withBase('/browse'),
                icons: [{ src: withBase('/icons/browse.png'), sizes: '96x96' }],
            },
            {
                name: 'Continue Watching',
                short_name: 'Continue',
                description: 'Resume your in-progress content',
                url: withBase('/?section=continue'),
                icons: [{ src: withBase('/icons/play.png'), sizes: '96x96' }],
            },
            {
                name: 'Search',
                short_name: 'Search',
                description: 'Search for movies and shows',
                url: withBase('/?search=open'),
                icons: [{ src: withBase('/icons/search.png'), sizes: '96x96' }],
            },
            {
                name: 'Watchlist',
                short_name: 'Watchlist',
                description: 'View your saved movies',
                url: withBase('/?section=watchlist'),
                icons: [{ src: withBase('/icons/watchlist.png'), sizes: '96x96' }],
            },
        ],
        launch_handler: {
            client_mode: 'navigate-existing',
        },
        display_override: ['window-controls-overlay', 'standalone', 'browser'],
    };

    return json(manifest, {
        headers: {
            'Content-Type': 'application/manifest+json',
            'Cache-Control': 'public, max-age=3600',
        },
    });
};
