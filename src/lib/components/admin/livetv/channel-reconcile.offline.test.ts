// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import type { AdminChannel } from '$lib/schemas/livetv.js';
import { channelMatches, normalizeFilter } from './channel-reconcile.js';

const ch = (state?: 'ok' | 'failing' | 'offline'): AdminChannel =>
    ({
        id: 'c',
        name: 'Chan',
        isVisible: true,
        health: state ? { state, consecutiveFailures: state === 'ok' ? 0 : 3 } : undefined,
    }) as AdminChannel;

describe('channelMatches offlineOnly', () => {
    const filter = normalizeFilter({ query: '', hideHidden: false, offlineOnly: true });

    test('keeps only offline feeds', () => {
        expect(channelMatches(ch('offline'), filter)).toBe(true);
        expect(channelMatches(ch('failing'), filter)).toBe(false);
        expect(channelMatches(ch('ok'), filter)).toBe(false);
        expect(channelMatches(ch(), filter)).toBe(false);
    });

    test('is off by default', () => {
        expect(channelMatches(ch('ok'), 'chan')).toBe(true);
    });
});
