// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    readMediaAvailability,
    readMediaRequestability,
    resolveMediaAvailability,
    resolveMediaRequestability,
} from './media-availability.js';

describe('media availability reader', () => {
    it.each([
        [{ availability: { isAvailable: false } }, false],
        [{ availability: { isAvailable: true } }, true],
        [{ isAvailable: false }, false],
        [{ isAvailable: true }, true],
        [{ is_available: false }, false],
        [{ is_available: true }, true],
        [{ availability: { hasFile: false } }, false],
        [{ availability: { hasFile: true } }, true],
        [{ hasFiles: false }, false],
        [{ hasFiles: true }, true],
        [{ has_files: false }, false],
        [{ has_files: true }, true],
        [{ ids: { internal: 'catalog-uuid', tmdb: '123' } }, undefined],
        [{ id: 'catalog-uuid', ProviderIds: { Tmdb: '123' } }, undefined],
        [{ isAvailable: 'false', has_files: 1 }, undefined],
        [null, undefined],
    ])('reads %j as %s', (value, expected) => {
        expect(readMediaAvailability(value)).toBe(expected);
    });

    it('prefers canonical nested evidence over conflicting flat and file signals', () => {
        expect(
            readMediaAvailability({
                availability: { isAvailable: false },
                isAvailable: true,
                has_files: true,
            }),
        ).toBe(false);
    });

    it('uses file evidence only when explicit availability is absent', () => {
        expect(readMediaAvailability({ isAvailable: false, hasFiles: true })).toBe(false);
        expect(readMediaAvailability({ hasFiles: true })).toBe(true);
    });

    it('uses the first source with a strict boolean and defaults missing evidence to false', () => {
        expect(resolveMediaAvailability({ isAvailable: false }, { isAvailable: true })).toBe(false);
        expect(resolveMediaAvailability({ isAvailable: 'yes' }, { has_files: true })).toBe(true);
        expect(resolveMediaAvailability({ id: 'uuid' })).toBe(false);
    });
});

describe('media requestability reader', () => {
    it.each([
        [{ availability: { canRequest: false } }, false],
        [{ availability: { canRequest: true } }, true],
        [{ canRequest: false }, false],
        [{ canRequest: true }, true],
        [{ can_request: false }, false],
        [{ can_request: true }, true],
        [{ canRequest: 'true' }, undefined],
    ])('reads %j as %s', (value, expected) => {
        expect(readMediaRequestability(value)).toBe(expected);
    });

    it('keeps the freshest explicit false and defaults absent evidence to false', () => {
        expect(resolveMediaRequestability({ canRequest: false }, { canRequest: true })).toBe(false);
        expect(resolveMediaRequestability({ id: 'uuid' })).toBe(false);
    });
});
