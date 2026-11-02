// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { AiUnavailableError } from './errors.js';
import type { PluginContext, MediaRef, ResolvedMediaChip } from './types.js';

describe('new context surfaces', () => {
    it('AiUnavailableError is throwable and named', () => {
        const e = new AiUnavailableError('no entitlement');
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('AiUnavailableError');
        expect(e.message).toBe('no entitlement');
    });

    it('PluginContext optional surfaces are typed (compile check)', () => {
        // Pure type-level assertion; constructing a fake ctx and reading optional fields.
        const fake = {} as PluginContext;
        expect(fake.user).toBeUndefined();
        expect(fake.realtime).toBeUndefined();
        expect(fake.media).toBeUndefined();
        expect(fake.ai).toBeUndefined();
        const ref: MediaRef = { id: 'u', mediaType: 'movie' };
        const chip: ResolvedMediaChip = { id: 'u', mediaType: 'movie', allowed: false };
        expect(ref.mediaType).toBe('movie');
        expect(chip.allowed).toBe(false);
    });
});
