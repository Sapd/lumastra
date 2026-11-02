// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turn instance settings on for ONE spec through the admin settings form action
 * (the same request the settings page sends), and put them back afterwards.
 *
 * Some routes 404 unless a feature flag is on (/music/map, /music/collections).
 * The CI UI job starts the dev server without those flags, and the settings are
 * read live, so a spec that needs them sets them itself instead of relying on
 * environment variables the job never exports. Always pair `set` with `restore`
 * (afterAll) so later specs in the same run see the defaults again.
 */
import { expect, request as playwrightRequest } from '@playwright/test';
import { ADMIN_FORWARD_AUTH_HEADERS } from '../fixtures/auth';

export type SettingValue = string | boolean | number;

// The save action accepts any settings key on any settings page.
const SAVE_URL = '/admin/settings/music?/save';

async function save(baseURL: string, updates: Record<string, SettingValue>): Promise<void> {
    // Own request context: a `beforeAll`/`afterAll` fixture `request` cannot be
    // used outside its hook, and the restore runs in a different hook.
    const api = await playwrightRequest.newContext({
        baseURL,
        extraHTTPHeaders: ADMIN_FORWARD_AUTH_HEADERS,
    });
    try {
        const res = await api.post(SAVE_URL, {
            headers: { Origin: new URL(baseURL).origin, 'x-sveltekit-action': 'true' },
            form: { updates: JSON.stringify(updates) },
        });
        expect(res.ok(), await res.text()).toBe(true);
        const body = (await res.json()) as { type?: string };
        expect(body.type, JSON.stringify(body)).toBe('success');
    } finally {
        await api.dispose();
    }
}

/** Apply `flags` and return the callback that undoes it. */
export async function setFeatureFlags(
    baseURL: string | undefined,
    flags: Record<string, SettingValue>,
    defaults: Record<string, SettingValue>,
): Promise<() => Promise<void>> {
    if (!baseURL) throw new Error('baseURL is required to change instance settings');
    await save(baseURL, flags);
    return () => save(baseURL, defaults);
}

/**
 * What /music/map and /music/collections need: sonic embeddings need an
 * embedding provider to count as configured (a custom endpoint WITH a key;
 * FEATURE_AI_RECOMMENDATIONS is on by default). The endpoint is a closed
 * loopback port, so nothing leaves the machine and any embedding call fails fast.
 */
export const SONIC_UI_FLAGS: Record<string, SettingValue> = {
    EMBEDDING_BASE_URL: 'http://127.0.0.1:9',
    EMBEDDING_API_KEY: 'e2e-not-a-real-key',
    FEATURE_MUSIC_SONIC: true,
    FEATURE_MUSIC_MAP: true,
    FEATURE_MUSIC_CLUSTERS: true,
};

/** The schema defaults of {@link SONIC_UI_FLAGS}, restored after the spec. */
export const SONIC_UI_DEFAULTS: Record<string, SettingValue> = {
    EMBEDDING_BASE_URL: '',
    EMBEDDING_API_KEY: '',
    FEATURE_MUSIC_SONIC: false,
    FEATURE_MUSIC_MAP: false,
    FEATURE_MUSIC_CLUSTERS: false,
};
