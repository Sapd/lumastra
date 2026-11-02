// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { matchJellyfinUsername } from './match-user.js';

describe('matchJellyfinUsername', () => {
    it('matches case-insensitively and returns the Jellyfin name', () => {
        expect(matchJellyfinUsername('Denis', ['alice', 'denis', 'bob'])).toBe('denis');
        expect(matchJellyfinUsername('denis', ['Denis'])).toBe('Denis');
    });

    it('returns null when no Jellyfin user matches', () => {
        expect(matchJellyfinUsername('denis', ['alice', 'bob'])).toBeNull();
        expect(matchJellyfinUsername('denis', [])).toBeNull();
    });

    it('ignores whitespace around names', () => {
        expect(matchJellyfinUsername('  denis ', ['  Denis  '])).toBe('  Denis  ');
    });

    it('returns null for an empty admin username', () => {
        expect(matchJellyfinUsername('', ['denis'])).toBeNull();
        expect(matchJellyfinUsername('   ', ['denis'])).toBeNull();
    });
});
