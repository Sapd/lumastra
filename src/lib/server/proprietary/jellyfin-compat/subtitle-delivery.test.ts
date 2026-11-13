// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Expected values follow Jellyfin's StreamBuilder.GetSubtitleProfile — see the
// module comment in subtitle-delivery.ts for where we deliberately differ.

import { describe, expect, it } from 'vitest';
import {
    allowsDirectPlay,
    engineCanBurnIn,
    resolveDeliverableSubtitle,
    formatFromStreamFile,
    resolveSubtitleDelivery,
    type SubtitleDeliveryContext,
    type SubtitleProfileLike,
} from './subtitle-delivery';

const HLS: SubtitleDeliveryContext = {
    playMethod: 'Transcode',
    outputContainer: 'ts',
    subProtocol: 'hls',
};
const directMkv: SubtitleDeliveryContext = { playMethod: 'DirectPlay', outputContainer: 'mkv' };

const pgs = { Codec: 'hdmv_pgs_subtitle', IsTextSubtitleStream: false, IsExternal: false };
const srt = { Codec: 'subrip', IsTextSubtitleStream: true, IsExternal: false };
const ass = { Codec: 'ass', IsTextSubtitleStream: true, IsExternal: false };

// The DeviceProfile from the 2026-10-02 GPU-test repro ("Jellyfin Web" via curl).
const REPRO: SubtitleProfileLike[] = [
    { Format: 'pgssub', Method: 'Encode' },
    { Format: 'srt', Method: 'External' },
];

// jellyfin-web 10.10's profile (browserDeviceProfile.js), abridged.
const WEB: SubtitleProfileLike[] = [
    { Format: 'vtt', Method: 'External' },
    { Format: 'ass', Method: 'External' },
    { Format: 'ssa', Method: 'External' },
    { Format: 'pgssub', Method: 'External' },
];

describe('resolveSubtitleDelivery', () => {
    it('burns in PGS for an HLS transcode when the profile only offers Encode', () => {
        expect(resolveSubtitleDelivery(pgs, REPRO, HLS)).toEqual({
            method: 'Encode',
            format: 'hdmv_pgs_subtitle',
        });
    });

    it('never answers Embed for MPEG-TS/HLS output, even with an Embed profile', () => {
        const profiles = [{ Format: 'pgssub', Method: 'Embed' }];
        expect(resolveSubtitleDelivery(pgs, profiles, HLS).method).toBe('Encode');
        expect(resolveSubtitleDelivery(srt, [{ Format: 'srt', Method: 'Embed' }], HLS).method).toBe(
            'Encode',
        );
    });

    it('embeds when direct playing a container the profile lists', () => {
        const profiles = [{ Format: 'pgssub', Method: 'Embed' }];
        expect(resolveSubtitleDelivery(pgs, profiles, directMkv)).toEqual({
            method: 'Embed',
            format: 'pgssub',
        });
    });

    it('respects an Embed profile Container restriction', () => {
        const profiles = [{ Format: 'pgssub', Method: 'Embed', Container: 'mp4' }];
        expect(resolveSubtitleDelivery(pgs, profiles, directMkv).method).toBe('Encode');
    });

    it('delivers a text track as External, matching codec aliases (subrip = srt)', () => {
        expect(resolveSubtitleDelivery(srt, REPRO, HLS)).toEqual({
            method: 'External',
            format: 'srt',
        });
    });

    it('converts a text track to the client sidecar format when no exact match exists', () => {
        expect(resolveSubtitleDelivery(srt, WEB, HLS)).toEqual({
            method: 'External',
            format: 'vtt',
        });
    });

    it('never converts ASS — it goes External as ASS or is burned in', () => {
        expect(resolveSubtitleDelivery(ass, WEB, HLS)).toEqual({
            method: 'External',
            format: 'ass',
        });
        expect(
            resolveSubtitleDelivery(ass, [{ Format: 'vtt', Method: 'External' }], HLS).method,
        ).toBe('Encode');
    });

    it('delivers PGS as an External sidecar when the client renders it', () => {
        expect(resolveSubtitleDelivery(pgs, WEB, HLS)).toEqual({
            method: 'External',
            format: 'pgssub',
        });
    });

    it('does not offer a text sidecar for an image track', () => {
        expect(
            resolveSubtitleDelivery(pgs, [{ Format: 'srt', Method: 'External' }], HLS).method,
        ).toBe('Encode');
    });

    it('skips Hls profiles (our master.m3u8 has no subtitle renditions)', () => {
        const profiles = [
            { Format: 'vtt', Method: 'Hls' },
            { Format: 'vtt', Method: 'External' },
        ];
        expect(resolveSubtitleDelivery(srt, profiles, HLS).method).toBe('External');
        expect(resolveSubtitleDelivery(srt, [{ Format: 'vtt', Method: 'Hls' }], HLS).method).toBe(
            'Encode',
        );
    });

    it('honours profile Language restrictions', () => {
        const profiles = [{ Format: 'srt', Method: 'External', Language: 'eng,ger' }];
        expect(resolveSubtitleDelivery({ ...srt, Language: 'ger' }, profiles, HLS).method).toBe(
            'External',
        );
        expect(resolveSubtitleDelivery({ ...srt, Language: 'fre' }, profiles, HLS).method).toBe(
            'Encode',
        );
    });

    it('does not convert subtitles of an infinite (live) source', () => {
        expect(
            resolveSubtitleDelivery(srt, [{ Format: 'vtt', Method: 'External' }], {
                ...HLS,
                isInfiniteStream: true,
            }).method,
        ).toBe('Encode');
    });
});

describe('allowsDirectPlay', () => {
    it('only Embed, External and Drop keep direct play', () => {
        expect(allowsDirectPlay('Embed')).toBe(true);
        expect(allowsDirectPlay('External')).toBe(true);
        expect(allowsDirectPlay('Drop')).toBe(true);
        expect(allowsDirectPlay('Encode')).toBe(false);
        expect(allowsDirectPlay('Hls')).toBe(false);
    });
});

describe('formatFromStreamFile', () => {
    it.each([
        ['Stream.vtt', 'vtt'],
        ['Stream.srt', 'srt'],
        ['Stream.ass', 'ass'],
        ['Stream.ssa', 'ass'],
        ['Stream.pgssub', 'pgssub'],
        ['Stream.sup', 'pgssub'],
        ['Stream.sub', 'sub'],
        ['Stream.js', 'vtt'],
        [undefined, 'vtt'],
    ])('%s → %s', (file, format) => {
        expect(formatFromStreamFile(file)).toBe(format);
    });
});

describe('resolveDeliverableSubtitle — limited to what our engine can burn in', () => {
    it('keeps Encode for an embedded bitmap track (the engine burns PGS/VobSub in)', () => {
        expect(resolveDeliverableSubtitle(pgs, REPRO, HLS)).toEqual({
            method: 'Encode',
            format: 'hdmv_pgs_subtitle',
        });
        expect(engineCanBurnIn(pgs)).toBe(true);
        expect(engineCanBurnIn({ ...pgs, Codec: 'dvd_subtitle' })).toBe(true);
    });

    it('turns Encode for a text track into a converted External sidecar', () => {
        expect(resolveDeliverableSubtitle(ass, REPRO, HLS)).toEqual({
            method: 'External',
            format: 'srt',
        });
        expect(engineCanBurnIn(ass)).toBe(false);
    });

    it('returns null when nothing deliverable exists (no burn-in promised)', () => {
        const pgsOnlyEncode = [{ Format: 'pgssub', Method: 'Encode' }];
        expect(resolveDeliverableSubtitle({ ...pgs, IsExternal: true }, REPRO, HLS)).toBeNull();
        expect(resolveDeliverableSubtitle(ass, pgsOnlyEncode, HLS)).toBeNull();
    });

    it('leaves non-Encode results untouched', () => {
        expect(resolveDeliverableSubtitle(srt, REPRO, HLS)).toEqual({
            method: 'External',
            format: 'srt',
        });
    });
});
