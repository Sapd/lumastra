// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards for the client-tuning transport.
 *
 * Two distinct failure modes, and the second is the one that actually bit:
 *
 * 1. A knob is serialized but the consumer keeps its literal — the state all
 *    nine keys were in before 2026-09-22. Grepping for the key name finds the
 *    layout block and looks wired. So the tests below assert at the SEAM each
 *    consumer actually uses (the `setInterval` delay, the toast's stored
 *    `timeout`, the SSE config object), not that the accessor returns what was
 *    hydrated — that would be asserting the module against itself.
 *
 * 2. A default drifts. The same number lives in three files (schema default,
 *    config.ts fallback, the literal each consumer used before wiring). Two of
 *    the three are pinned by `config.schema-consistency.test.ts`; this pins the
 *    third against the schema, closing the triangle.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { configSchema } from '$lib/config/schema.js';
import {
    CLIENT_TUNING_DEFAULTS,
    clientTuning,
    hydrateClientTuning,
    resetClientTuning,
    partiesRefreshMs,
    playlistChatPollMs,
    toastDefaultTimeoutMs,
    watchTogetherMaxReconnectMs,
} from './client-tuning.js';

beforeEach(() => resetClientTuning());

describe('client tuning defaults', () => {
    it.each([
        ['partiesRefreshMs', 'WATCH_PARTIES_REFRESH_MS'],
        ['watchTogetherMaxReconnectMs', 'WATCH_TOGETHER_MAX_RECONNECT_MS'],
        ['playlistChatPollMs', 'PLAYLIST_CHAT_POLL_MS'],
        ['toastDefaultTimeoutMs', 'TOAST_DEFAULT_TIMEOUT_MS'],
        ['playerSkipSeconds', 'PLAYER_SKIP_SECONDS'],
        ['abrStabilityMs', 'PLAYER_QUALITY_STABILITY_MS'],
        ['abrDownCooldownMs', 'PLAYER_QUALITY_DOWN_COOLDOWN_MS'],
        ['abrUpCooldownMs', 'PLAYER_QUALITY_UP_COOLDOWN_MS'],
        ['abrBandwidthSamples', 'PLAYER_BANDWIDTH_SAMPLES'],
        ['abrMinSamplesBeforeSwitch', 'PLAYER_MIN_SAMPLES_BEFORE_SWITCH'],
        ['abrMinAdaptiveBitrate', 'PLAYER_MIN_ADAPTIVE_BITRATE'],
        ['requestAvailableExpireHours', 'REQUEST_AVAILABLE_EXPIRE_HOURS'],
    ] as const)('`%s` defaults to the schema default for %s', (field, key) => {
        const setting = configSchema.find((s) => s.key === key);
        // Guards the assertion from passing vacuously if the key is retired
        // later without this file being updated.
        expect(setting, `${key} is no longer in the schema`).toBeDefined();
        expect(CLIENT_TUNING_DEFAULTS[field]).toBe(setting?.defaultValue);
    });

    it.each([
        'WATCH_TOGETHER_SYNC_INTERVAL_MS',
        'WATCH_TOGETHER_DRIFT_CHECK_MS',
        'WATCH_TOGETHER_CATCHUP_CHECK_MS',
        'ADMIN_TASKS_REFRESH_MS',
        'IMAGE_THUMB_MAX_WIDTH',
    ])('the retired knob %s is gone from the schema (no live-looking admin control)', (key) => {
        expect(configSchema.find((s) => s.key === key)).toBeUndefined();
    });
});

describe('hydrateClientTuning', () => {
    it('takes server values', () => {
        hydrateClientTuning({ partiesRefreshMs: 45000, toastDefaultTimeoutMs: 2000 });
        expect(partiesRefreshMs()).toBe(45000);
        expect(toastDefaultTimeoutMs()).toBe(2000);
    });

    it('leaves fields the server omitted at their defaults', () => {
        hydrateClientTuning({ partiesRefreshMs: 45000 });
        expect(playlistChatPollMs()).toBe(CLIENT_TUNING_DEFAULTS.playlistChatPollMs);
        expect(watchTogetherMaxReconnectMs()).toBe(
            CLIENT_TUNING_DEFAULTS.watchTogetherMaxReconnectMs,
        );
    });

    it('is a replace, not an accumulate — a later payload drops an earlier value', () => {
        hydrateClientTuning({ partiesRefreshMs: 45000 });
        hydrateClientTuning({ playlistChatPollMs: 20000 });
        // The layout re-hydrates on every navigation; if this accumulated, a
        // value cleared server-side would stick for the rest of the session.
        expect(partiesRefreshMs()).toBe(CLIENT_TUNING_DEFAULTS.partiesRefreshMs);
        expect(playlistChatPollMs()).toBe(20000);
    });

    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty object', {}],
    ])('survives %s without changing anything', (_label, payload) => {
        hydrateClientTuning(payload as never);
        expect(clientTuning()).toEqual(CLIENT_TUNING_DEFAULTS);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['zero', 0],
        ['negative', -1000],
        ['a string', '5000'],
    ])('rejects %s and keeps the default', (_label, bad) => {
        // setInterval(fn, NaN) fires as fast as the browser allows, and 0 is a
        // busy loop — a malformed payload must not become a request storm.
        hydrateClientTuning({ partiesRefreshMs: bad as number });
        expect(partiesRefreshMs()).toBe(CLIENT_TUNING_DEFAULTS.partiesRefreshMs);
    });
});

describe('the toast store reads the configured timeout (seam: the stored toast)', () => {
    afterEach(() => {
        vi.useRealTimers();
        resetClientTuning();
    });

    async function firstToast(act: (t: typeof import('./toast.store.svelte.js').toasts) => void) {
        const { toasts } = await import('./toast.store.svelte.js');
        toasts.clear();
        let seen: { timeout?: number }[] = [];
        const unsub = toasts.subscribe((v) => (seen = v));
        act(toasts);
        unsub();
        return seen[0];
    }

    it('a toast created with no explicit timeout carries the hydrated value', async () => {
        hydrateClientTuning({ toastDefaultTimeoutMs: 1234 });
        // `success()` passes its own default through to push(), so wiring only
        // push() would leave this at 5000 — that is the bug this pins.
        expect((await firstToast((t) => t.success('hi')))?.timeout).toBe(1234);
        expect((await firstToast((t) => t.info('hi')))?.timeout).toBe(1234);
        expect((await firstToast((t) => t.warning('hi')))?.timeout).toBe(1234);
        expect((await firstToast((t) => t.show('hi')))?.timeout).toBe(1234);
    });

    it('an explicit caller timeout still wins over the configured default', async () => {
        hydrateClientTuning({ toastDefaultTimeoutMs: 1234 });
        expect((await firstToast((t) => t.success('hi', 99)))?.timeout).toBe(99);
    });

    it('without hydration it is exactly the pre-wiring 5000', async () => {
        expect((await firstToast((t) => t.success('hi')))?.timeout).toBe(5000);
    });
});

describe('the two component consumers read page data rather than a literal', () => {
    // These read their interval once at mount, so there is no runtime seam to
    // observe without a full component harness. A source check is a fair match
    // for the risk: the defect that killed all nine knobs was literally "the
    // component hardcodes the number", and it survived for months precisely
    // because nothing ever looked at the source.
    //
    // They read `page.data.clientTuning`, NOT the hydrated module above: the
    // layout's hydration $effect is not guaranteed to have flushed by the time
    // a child mounts, while page data is populated synchronously.
    it.each([
        ['../components/WatchParties.svelte', 'partiesRefreshMs'],
        ['../components/playlist/PlaylistChat.svelte', 'playlistChatPollMs'],
    ])('%s reads clientTuning.%s and no longer hardcodes 15000', async (relPath, field) => {
        const { readFileSync } = await import('node:fs');
        const source = readFileSync(new URL(relPath, import.meta.url), 'utf-8');
        expect(source).toContain(`clientTuning?.${field}`);
        // Scoped to the interval call so an unrelated 15000 elsewhere in the
        // file (a timeout, a duration) does not fail this.
        expect(source).not.toMatch(/setInterval\([\s\S]{0,400}?\},\s*15000\s*\)/);
    });
});
