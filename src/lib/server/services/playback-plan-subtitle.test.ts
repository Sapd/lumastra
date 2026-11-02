// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    BURN_IN_CODECS,
    isBurnInCodec,
    isPgsCodec,
    isAssCodec,
    isVobsubCodec,
} from '$lib/components/player/subtitle-utils.js';

describe('Subtitle burn-in consistency', () => {
    it('BURN_IN_CODECS contains both DVB aliases and XSUB only', () => {
        expect(BURN_IN_CODECS).toEqual(['dvbsub', 'dvb_subtitle', 'xsub']);
    });

    it('dvdsub is NOT a burn-in codec (client-renderable via libbitsub)', () => {
        expect(isBurnInCodec('dvdsub')).toBe(false);
    });

    it('vobsub is NOT a burn-in codec (client-renderable via libbitsub)', () => {
        expect(isBurnInCodec('vobsub')).toBe(false);
    });

    it.each(['dvbsub', 'dvb_subtitle', 'DVB_SUBTITLE'])('%s IS a DVB burn-in codec', (codec) => {
        expect(isBurnInCodec(codec)).toBe(true);
    });

    it('xsub IS a burn-in codec', () => {
        expect(isBurnInCodec('xsub')).toBe(true);
    });

    it('PGS is client-renderable (not burn-in)', () => {
        expect(isPgsCodec('hdmv_pgs_subtitle')).toBe(true);
        expect(isBurnInCodec('hdmv_pgs_subtitle')).toBe(false);
    });

    it('ASS is client-renderable (not burn-in)', () => {
        expect(isAssCodec('ass')).toBe(true);
        expect(isBurnInCodec('ass')).toBe(false);
    });

    it('VobSub variants are client-renderable', () => {
        for (const codec of ['dvdsub', 'vobsub', 'dvd_subtitle']) {
            expect(isVobsubCodec(codec)).toBe(true);
            expect(isBurnInCodec(codec)).toBe(false);
        }
    });
});
