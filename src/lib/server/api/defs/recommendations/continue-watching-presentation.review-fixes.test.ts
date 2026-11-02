// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { presentContinueWatchingItem } from './continue-watching-presentation.js';

const base = {
    id: '11111111-1111-4111-8111-111111111111',
    mediaType: 'movie',
    title: 'T',
    externalIds: {},
} as never;

describe('presentContinueWatchingItem progress', () => {
    it('keeps the watchProgress percent as fraction when the duration is unknown', () => {
        const out = presentContinueWatchingItem({ ...(base as object), watchProgress: 40 } as never);
        expect(out?.progress.fraction).toBe(0.4);
        expect(out?.progress.durationMs).toBeNull();
    });

    it('clamps and leaves unknown when there is no progress', () => {
        expect(
            presentContinueWatchingItem({ ...(base as object), watchProgress: 250 } as never)?.progress
                .fraction,
        ).toBe(1);
        expect(
            presentContinueWatchingItem({ ...(base as object), watchProgress: 0 } as never)?.progress
                .fraction,
        ).toBeNull();
    });
});
