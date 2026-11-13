// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { configSchema } from './schema';
import { TRAINING_USE_CASE } from './use-case-ids';

function find(key: string) {
    return configSchema.find((s) => s.key === key);
}

describe('instance-profile schema keys', () => {
    it('INSTANCE_PRIMARY_MODE offers a training option', () => {
        const opts = find('INSTANCE_PRIMARY_MODE')?.validation?.options?.map((o) => o.value);
        expect(opts).toEqual(expect.arrayContaining(['vod', 'music', 'mixed', TRAINING_USE_CASE]));
    });

    it('INSTANCE_PRIMARY_MODE offers a showcase option', () => {
        const opts = find('INSTANCE_PRIMARY_MODE')?.validation?.options?.map((o) => o.value);
        expect(opts).toEqual(expect.arrayContaining(['showcase']));
    });

    it('INSTANCE_LANDING_PATH is a string defaulting to empty and not requiresRestart', () => {
        const e = find('INSTANCE_LANDING_PATH');
        expect(e?.type).toBe('string');
        expect(e?.defaultValue).toBe('');
        expect(e?.requiresRestart).not.toBe(true);
    });

    it('INSTANCE_USE_CASES is an array defaulting to []', () => {
        const e = find('INSTANCE_USE_CASES');
        expect(e?.type).toBe('array');
        expect(e?.defaultValue).toEqual([]);
    });

    it('INSTANCE_PROFILE_APPLIED is a hidden string defaulting to empty', () => {
        const e = find('INSTANCE_PROFILE_APPLIED');
        expect(e?.type).toBe('string');
        expect(e?.defaultValue).toBe('');
        expect(e?.uiHints?.hidden).toBe(true);
    });

    it('FEATURE_PUBLIC_SHOWCASE defaults to false and does not requiresRestart', () => {
        const e = find('FEATURE_PUBLIC_SHOWCASE');
        expect(e?.type).toBe('boolean');
        expect(e?.defaultValue).toBe(false);
        expect(e?.requiresRestart).toBe(false);
    });

    it('SHOWCASE_REQUIRE_TOKEN defaults to true', () => {
        const e = find('SHOWCASE_REQUIRE_TOKEN');
        expect(e?.type).toBe('boolean');
        expect(e?.defaultValue).toBe(true);
    });

    it('SHOWCASE_ALLOW_EMBED defaults to false', () => {
        const e = find('SHOWCASE_ALLOW_EMBED');
        expect(e?.type).toBe('boolean');
        expect(e?.defaultValue).toBe(false);
    });

    it('SHOWCASE_PUBLIC_LIBRARY_GROUP_ID is a string defaulting to empty', () => {
        const e = find('SHOWCASE_PUBLIC_LIBRARY_GROUP_ID');
        expect(e?.type).toBe('string');
        expect(e?.defaultValue).toBe('');
    });

    it('SHOWCASE_EMBED_ALLOWED_ORIGINS is an array defaulting to []', () => {
        const e = find('SHOWCASE_EMBED_ALLOWED_ORIGINS');
        expect(e?.type).toBe('array');
        expect(e?.defaultValue).toEqual([]);
    });

    it('SHOWCASE_KIOSK_MODE defaults to false', () => {
        const e = find('SHOWCASE_KIOSK_MODE');
        expect(e?.type).toBe('boolean');
        expect(e?.defaultValue).toBe(false);
    });
});
