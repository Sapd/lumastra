// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as seed from './global-setup';
import { SEEDED_MUSIC_TRACK } from './helpers/music-fixture';
import { MusicTrackSchema } from '../src/lib/schemas/music';
import { PlaybackStartRequestSchema } from '../src/lib/schemas/playback-start';

describe('E2E seed API contracts', () => {
    it.each(Object.entries(seed).filter(([name]) => name.endsWith('_ID')))(
        '%s is accepted by the API UUID validator',
        (_name, id) => {
            expect(z.uuid().safeParse(id).success).toBe(true);
        },
    );
    it.each([
        seed.TEST_MEDIA_ITEM_ID,
        seed.TEST_RELATED_MEDIA_ITEM_ID,
        seed.TEST_EP1_ID,
        seed.TEST_EP2_ID,
        seed.TEST_EP3_ID,
        seed.TEST_EP4_ID,
        seed.TEST_MUSIC_TRACK_ID,
        seed.TEST_MUSIC_TRACK_2_ID,
    ])('can start the seeded media %s', (mediaId) => {
        expect(PlaybackStartRequestSchema.safeParse({ mediaId, deviceId: 'e2e' }).success).toBe(
            true,
        );
    });
    it('injects the same music DTO accepted from recommendations', () => {
        expect(MusicTrackSchema.safeParse(SEEDED_MUSIC_TRACK).success).toBe(true);
    });
});
