// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '/media' }));
vi.mock('$lib/server/config', () => ({ config: { PUBLIC_BASE_URL: '' } }));

import { config } from '$lib/server/config';
import { advertisedBaseUrl } from './advertised-base-url';

afterEach(() => {
    Object.assign(config, { PUBLIC_BASE_URL: '' });
});

describe('advertisedBaseUrl', () => {
    it('prefers the configured public URL over the request origin', () => {
        Object.assign(config, { PUBLIC_BASE_URL: 'https://public.example/media/' });
        expect(advertisedBaseUrl(new URL('http://internal:3000/media/j/System/Info'))).toBe(
            'https://public.example/media',
        );
    });

    it('keeps the base path when it falls back to the request origin', () => {
        expect(advertisedBaseUrl(new URL('https://host.example/media/j/System/Info'))).toBe(
            'https://host.example/media',
        );
    });

    it('ignores an invalid public URL', () => {
        Object.assign(config, { PUBLIC_BASE_URL: 'not a url' });
        expect(advertisedBaseUrl(new URL('https://host.example/media/j/'))).toBe(
            'https://host.example/media',
        );
    });
});
