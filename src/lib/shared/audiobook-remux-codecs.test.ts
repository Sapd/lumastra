// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The engine stubs in this file are not invented: they return exactly what real
 * Google Chrome and real WebKit returned for these strings, measured through
 * Playwright on 2026-07-30. That is the whole point of the file — the decision
 * this module makes is only as good as the probe strings, and the two obvious
 * probe strings (`audio/eac3`, `audio/ac3`) are `""` on BOTH engines including
 * the one that plays the codec.
 */

import { describe, it, expect } from 'vitest';
import {
    audiobookCodecNeedsRemux,
    audiobookCodecProbeTypes,
    engineCanDecodeAudiobookCodec,
    isAudiobookCodecKnown,
    normalizeAudiobookCodec,
} from './audiobook-remux-codecs';

/** Real Chrome, measured. */
const chrome = (type: string): string =>
    ({
        'audio/mp4; codecs="ec-3"': '',
        'audio/mp4; codecs="ac-3"': '',
        'audio/mp4; codecs="alac"': '',
        'audio/eac3': '',
        'audio/ac3': '',
        'audio/mp4; codecs="mp4a.40.2"': 'probably',
        'audio/aac': 'probably',
        'audio/mpeg': 'probably',
        'audio/flac': 'probably',
    })[type] ?? '';

/** Real WebKit, measured. */
const webkit = (type: string): string =>
    ({
        'audio/mp4; codecs="ec-3"': 'probably',
        'audio/mp4; codecs="ac-3"': 'probably',
        'audio/mp4; codecs="alac"': 'probably',
        'audio/eac3': '',
        'audio/ac3': '',
        'audio/mp4; codecs="mp4a.40.2"': 'probably',
        'audio/aac': 'maybe',
        'audio/mpeg': 'maybe',
        'audio/flac': 'maybe',
    })[type] ?? '';

describe('audiobookCodecNeedsRemux', () => {
    it('flags E-AC-3 — the codec ABS direct-plays and Chromium cannot decode', () => {
        expect(audiobookCodecNeedsRemux('eac3')).toBe(true);
    });

    it('does NOT flag the codecs the whole library actually uses', () => {
        // Measured over the live library: 48888 mp3 files, 500 flac, 40 aac,
        // 39 eac3. Flagging any of the first three would remux 1186 of 1188
        // books for nothing.
        for (const codec of ['mp3', 'flac', 'aac', 'opus', 'vorbis', 'pcm_s16le']) {
            expect(audiobookCodecNeedsRemux(codec)).toBe(false);
        }
    });

    it('normalises case and padding, because two sources fill this field', () => {
        // The live session payload and our own persisted sweep output; neither
        // promises a case.
        expect(audiobookCodecNeedsRemux(' EAC3 ')).toBe(true);
        expect(audiobookCodecNeedsRemux('EAc3')).toBe(true);
    });

    it('answers false for a missing codec — which is NOT a claim that it is safe', () => {
        // A transcode session's synthetic whole-book track reports codec null.
        // This predicate only ever says "not in the measured-risky set", and
        // `isAudiobookCodecKnown` is what tells the two apart. Reading this false
        // as "safe" is what direct-played an unprobeable file into a dead element.
        expect(audiobookCodecNeedsRemux(null)).toBe(false);
        expect(audiobookCodecNeedsRemux(undefined)).toBe(false);
        expect(audiobookCodecNeedsRemux('')).toBe(false);
        // Same answer as a genuinely safe codec — the ambiguity, demonstrated.
        expect(audiobookCodecNeedsRemux('aac')).toBe(false);
    });
});

describe('isAudiobookCodecKnown', () => {
    it('separates "we read a codec" from "the codec is safe"', () => {
        // The distinction `audiobookCodecNeedsRemux` cannot express: both of these
        // are `false` there.
        expect(isAudiobookCodecKnown('aac')).toBe(true);
        expect(isAudiobookCodecKnown(null)).toBe(false);
    });

    it('is true for any non-blank codec, including ones not in the table', () => {
        // "Known" means READ, not catalogued. A codec we have never measured is
        // still information about the file.
        for (const codec of ['mp3', 'flac', 'eac3', 'some-new-codec']) {
            expect(isAudiobookCodecKnown(codec)).toBe(true);
        }
    });

    it('is false for every shape of "no codec" the two sources produce', () => {
        for (const codec of [null, undefined, '', '   ', '\t']) {
            expect(isAudiobookCodecKnown(codec)).toBe(false);
        }
    });
});

describe('normalizeAudiobookCodec', () => {
    it('lowercases and trims', () => {
        expect(normalizeAudiobookCodec('  EAC3 ')).toBe('eac3');
        expect(normalizeAudiobookCodec(null)).toBe('');
    });
});

describe('audiobookCodecProbeTypes', () => {
    it('offers the mp4-scoped probe for E-AC-3 and NOT the bare type', () => {
        // `audio/eac3` measured '' on WebKit too, i.e. on the engine that plays
        // the codec. Offering it would make every Safari listener remux.
        expect(audiobookCodecProbeTypes('eac3')).toEqual(['audio/mp4; codecs="ec-3"']);
    });

    it('offers no probe for codecs no measured engine plays', () => {
        // Empty is meaningful: there is no question worth asking, so the answer
        // is always "remux".
        expect(audiobookCodecProbeTypes('wmav2')).toEqual([]);
        expect(audiobookCodecProbeTypes('dts')).toEqual([]);
        expect(audiobookCodecProbeTypes('truehd')).toEqual([]);
    });

    it('returns nothing for a codec it does not know', () => {
        expect(audiobookCodecProbeTypes('mp3')).toEqual([]);
    });
});

describe('engineCanDecodeAudiobookCodec', () => {
    it('says NO for E-AC-3 in Chrome — the measured EncodingError case', () => {
        expect(engineCanDecodeAudiobookCodec('eac3', chrome)).toBe(false);
    });

    it('says YES for E-AC-3 in WebKit, so Safari never pays for a remux', () => {
        expect(engineCanDecodeAudiobookCodec('eac3', webkit)).toBe(true);
    });

    it('splits AC-3 and ALAC the same way (Chrome no, WebKit yes)', () => {
        expect(engineCanDecodeAudiobookCodec('ac3', chrome)).toBe(false);
        expect(engineCanDecodeAudiobookCodec('ac3', webkit)).toBe(true);
        expect(engineCanDecodeAudiobookCodec('alac', chrome)).toBe(false);
        expect(engineCanDecodeAudiobookCodec('alac', webkit)).toBe(true);
    });

    it('says NO on both engines for the codecs neither plays', () => {
        for (const codec of ['wmav2', 'dts', 'truehd']) {
            expect(engineCanDecodeAudiobookCodec(codec, chrome)).toBe(false);
            expect(engineCanDecodeAudiobookCodec(codec, webkit)).toBe(false);
        }
    });

    it("treats 'maybe' as playable, not as a no", () => {
        // WebKit answers 'maybe' for several types it plays perfectly well.
        // Only '' is a refusal.
        expect(engineCanDecodeAudiobookCodec('eac3', () => 'maybe')).toBe(true);
    });

    it('says NO for an unknown codec rather than assuming it is fine', () => {
        // Reached only for a file the server already flagged; a flagged file we
        // cannot identify is safer remuxed than played into a dead element.
        expect(engineCanDecodeAudiobookCodec(null, () => 'probably')).toBe(false);
        expect(engineCanDecodeAudiobookCodec('some-new-codec', () => 'probably')).toBe(false);
    });
});
