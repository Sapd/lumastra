// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where the native Apple apps (iPhone, iPad, Apple TV) can be installed.
 *
 * While the app is TestFlight-only, the web app shows its own "Get the app"
 * hint (AppInstallHint.svelte) to Safari on iPhone/iPad — Apple's Smart App
 * Banner only works for apps that are live on the App Store.
 *
 * TODO(app-store): once the app is on the App Store, set `appStoreId` and
 * replace AppInstallHint with `<meta name="apple-itunes-app" content="app-id=…">`
 * in app.html (Safari then renders its own banner, which also detects whether
 * the app is already installed).
 */
export const IOS_APP = {
    testFlightUrl: 'https://testflight.apple.com/join/m8EUbgJQ',
    /** Numeric App Store id (`id1234567890` → `'1234567890'`); null until the app is live. */
    appStoreId: null as string | null,
} as const;
