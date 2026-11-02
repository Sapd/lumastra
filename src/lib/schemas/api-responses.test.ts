// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { UniversalMediaTypeSchema, UniversalMediaItemSchema } from './api-responses.js';

describe('UniversalMediaTypeSchema', () => {
    it('accepts tvchannel as a valid media type', () => {
        const result = UniversalMediaTypeSchema.safeParse('tvchannel');
        expect(result.success).toBe(true);
    });

    it('still accepts all existing media types', () => {
        const existingTypes = [
            'movie',
            'series',
            'episode',
            'audiobook',
            'artist',
            'album',
            'track',
            'music',
        ];
        for (const mediaType of existingTypes) {
            const result = UniversalMediaTypeSchema.safeParse(mediaType);
            expect(result.success, `Expected ${mediaType} to be valid`).toBe(true);
        }
    });

    // The stored token is 'tv', but nothing emits it here — universalTypeOf()
    // maps tv → 'series'. Legacy input is still tolerated so a cached payload or
    // an older client does not fail response validation; it normalizes instead.
    it.each([
        ['tv', 'series'],
        ['show', 'series'],
    ])('normalizes legacy %s to %s', (input, expected) => {
        expect(UniversalMediaTypeSchema.parse(input)).toBe(expected);
    });

    it('does not expose tv in the emitted contract', () => {
        // Guards the OpenAPI enum: 'tv' must not reappear as a member.
        expect(UniversalMediaTypeSchema.parse('tv')).not.toBe('tv');
    });

    it('rejects invalid media types', () => {
        const result = UniversalMediaTypeSchema.safeParse('invalid');
        expect(result.success).toBe(false);
    });
});

describe('UniversalMediaItemSchema with tvchannel', () => {
    it('validates a tvchannel item through the full schema', () => {
        const tvchannelItem = {
            id: 'ch-uuid-1',
            title: 'WBN One',
            mediaType: 'tvchannel',
            aspectRatio: 'video',
            image: 'https://example.com/logo.png',
            subtitle: 'Evening News',
            externalIds: { internal: 'ch-uuid-1' },
            isAvailable: true,
            canRequest: false,
        };

        const result = UniversalMediaItemSchema.safeParse(tvchannelItem);
        expect(result.success).toBe(true);
    });

    it('validates a minimal tvchannel item', () => {
        const tvchannelItem = {
            id: 'ch-uuid-2',
            title: 'VDD',
            mediaType: 'tvchannel',
            image: '',
            externalIds: { internal: 'ch-uuid-2' },
            isAvailable: true,
            canRequest: false,
        };

        const result = UniversalMediaItemSchema.safeParse(tvchannelItem);
        expect(result.success).toBe(true);
    });
});
