// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getMediaTransformerService } from './media-transformer.service.js';

const transformer = getMediaTransformerService();

describe('MediaTransformerService availability', () => {
    it.each([
        [{ id: 'catalog-id', media_type: 'movie' }, false],
        [{ id: 'catalog-id', media_type: 'movie', has_files: false }, false],
        [{ id: 'catalog-id', media_type: 'movie', has_files: true }, true],
        [{ id: 'catalog-id', media_type: 'movie', hasFiles: true }, true],
        [{ id: 'catalog-id', media_type: 'movie', is_available: true }, true],
        [{ id: 'catalog-id', media_type: 'movie', isAvailable: false, has_files: true }, false],
        [{ id: 'catalog-id', media_type: 'movie', jellyfin: 'provider-id' }, false],
    ])('transforms %j with availability %s', (row, expected) => {
        const item = transformer.transformToUniversalMedia(row, { prefix: 'test' });
        expect(item?.isAvailable).toBe(expected);
    });
});
