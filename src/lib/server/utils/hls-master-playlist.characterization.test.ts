// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CHARACTERIZATION suite for the three master-playlist generators.
 *
 * This is a safety net for the unification refactor, not a specification. Its
 * job is to fail on ANY change to emitted bytes — attribute order, blank lines,
 * section order, trailing newline — none of which the behavioural suite in
 * hls-master-playlist.test.ts pins, because that one asserts on individual
 * attributes rather than whole documents.
 *
 * Written and committed BEFORE the refactor so the refactor's diff can be shown
 * to be inert. A snapshot changing during that refactor means the refactor is
 * not behaviour-preserving and needs justification, not a snapshot update.
 *
 * These snapshots record what the code DOES today, including things that are
 * arguably wrong. Three known divergences are probed explicitly below — the same
 * "gate the subtitle group on ids" rule is implemented with three different
 * conditions across the three generators:
 *
 *   demux       subtitleTracks.length > 0 && itemId && fileId
 *   muxed       fileId && segmentBase
 *   audio-only  fileId
 *
 * `buildSubtitleMediaLines` itself uses only segmentBase/params/fileId — never
 * itemId. The probes exist so that if the unification changes any of these, the
 * change shows up as a snapshot diff and has to be argued for deliberately
 * rather than slipping through.
 */

import { describe, it, expect } from 'vitest';
import {
    generateMasterPlaylist,
    generateMuxedMasterPlaylist,
    generateAudioOnlyMasterPlaylist,
    AUDIO_ONLY_BANDWIDTH,
    type MasterPlaylistVideoInfo,
    type MasterPlaylistTrickplayInfo,
    type MasterPlaylistOptions,
} from './hls-master-playlist.js';
import type { AudioTrackInfo, SubtitleTrackInfo } from './hls-audio-injection.js';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SEGMENT_BASE = '/api/v1/playback/itm_1/hls';
const PARAMS = new URLSearchParams({ playSessionId: 'ps_1', planId: 'plan_1' });
const ITEM_ID = 'itm_1';
const FILE_ID = 'file_1';

const AUDIO: AudioTrackInfo[] = [
    {
        index: asAbsoluteStreamIndex(1),
        displayTitle: 'English AAC 5.1',
        language: 'eng',
        channels: 6,
        codec: 'aac',
        bitrate: 384_000,
        isDefault: true,
    },
    {
        index: asAbsoluteStreamIndex(2),
        displayTitle: 'Deutsch DTS',
        language: 'deu',
        channels: 6,
        codec: 'dts',
        bitrate: 1_536_000,
        isDefault: false,
    },
];

const SUBS: SubtitleTrackInfo[] = [
    {
        index: 3,
        displayTitle: 'English (Forced)',
        language: 'eng',
        codec: 'subrip',
        isDefault: false,
        isForced: true,
        isTextBased: true,
    },
    {
        index: 4,
        displayTitle: 'Deutsch',
        language: 'deu',
        codec: 'subrip',
        isDefault: true,
        isForced: false,
        isTextBased: true,
    },
];

const SDR_H264: MasterPlaylistVideoInfo = {
    codec: 'h264',
    width: 1920,
    height: 1080,
    bitrate: 8_000_000,
    frameRate: 23.976,
};

const HDR10_HEVC: MasterPlaylistVideoInfo = {
    codec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 40_000_000,
    frameRate: 23.976,
    videoRange: 'HDR',
    videoRangeType: 'HDR10',
    // 120 (Level 4.0), NOT 153. `hevcLevelString` FALLS BACK to 153, so a
    // fixture using 153 would be byte-identical to one where the refactor
    // dropped the `level` plumb-through entirely. Over-declaring L153 on a
    // Level-4.0 copy makes Firefox/VA-API reject and stall ~1s in.
    level: 120,
    isTranscoded: false,
};

const DOLBY_VISION: MasterPlaylistVideoInfo = {
    codec: 'hevc',
    width: 3840,
    height: 2160,
    bitrate: 48_000_000,
    frameRate: 23.976,
    videoRange: 'HDR',
    videoRangeType: 'DOVIWithHDR10',
    dvProfile: 8,
    dvBlSignalCompatibilityId: 1,
    level: 153,
    isTranscoded: false,
} as MasterPlaylistVideoInfo;

const TRICKPLAY: MasterPlaylistTrickplayInfo = {
    width: 320,
    height: 180,
    tileWidth: 10,
    tileHeight: 10,
    thumbnailCount: 400,
    interval: 10_000,
    bandwidth: 50_000,
};

const ALL_OPTIONS: MasterPlaylistOptions = {
    includeTrickplay: true,
    syntheticIframes: true,
    audioCodec: 'aac',
    isAudioCopied: false,
    hlsContainer: 'fmp4',
};

// ── demux ─────────────────────────────────────────────────────────────────────

describe('generateMasterPlaylist (demux) — characterization', () => {
    it('kitchen sink: 2 audio, 2 subs, trickplay, synthetic iframes, HDR10', () => {
        expect(
            generateMasterPlaylist(
                AUDIO,
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                12_000_000,
                HDR10_HEVC,
                'hevc',
                ITEM_ID,
                FILE_ID,
                TRICKPLAY,
                ALL_OPTIONS,
            ),
        ).toMatchSnapshot();
    });

    it('minimal: 1 audio, no subs, no video info, no options', () => {
        expect(
            generateMasterPlaylist([AUDIO[0]], undefined, SEGMENT_BASE, PARAMS, 5_000_000),
        ).toMatchSnapshot();
    });

    it('SDR h264 with subtitles, no trickplay/iframes', () => {
        expect(
            generateMasterPlaylist(
                AUDIO,
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                8_000_000,
                SDR_H264,
                'h264',
                ITEM_ID,
                FILE_ID,
            ),
        ).toMatchSnapshot();
    });

    it('Dolby Vision, mpegts container', () => {
        expect(
            generateMasterPlaylist(
                AUDIO,
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                48_000_000,
                DOLBY_VISION,
                'hevc',
                ITEM_ID,
                FILE_ID,
                undefined,
                { ...ALL_OPTIONS, hlsContainer: 'mpegts', syntheticIframes: false },
            ),
        ).toMatchSnapshot();
    });

    // ── DIVERGENCE PROBE ──
    it('PROBE: subs present, fileId present, itemId ABSENT — demux drops the subtitle group', () => {
        const out = generateMasterPlaylist(
            AUDIO,
            SUBS,
            SEGMENT_BASE,
            PARAMS,
            8_000_000,
            SDR_H264,
            'h264',
            undefined, // itemId
            FILE_ID,
        );
        // Recorded as-is. buildSubtitleMediaLines never reads itemId, so this
        // gate looks over-strict — but that is a behaviour change to argue
        // separately, not to slip into a refactor.
        expect(out).not.toContain('TYPE=SUBTITLES');
        expect(out).toMatchSnapshot();
    });

    it('PROBE: subs present, itemId present, fileId ABSENT — demux drops the subtitle group', () => {
        const out = generateMasterPlaylist(
            AUDIO,
            SUBS,
            SEGMENT_BASE,
            PARAMS,
            8_000_000,
            SDR_H264,
            'h264',
            ITEM_ID,
            undefined, // fileId
        );
        expect(out).not.toContain('TYPE=SUBTITLES');
        expect(out).toMatchSnapshot();
    });

    it('emits no dangling AUDIO group when there are zero audio tracks', () => {
        // RFC 8216 4.3.4.2: a STREAM-INF's AUDIO attribute MUST match the
        // GROUP-ID of an EXT-X-MEDIA tag in the same master. With no audio
        // tracks there is no such tag, so the attribute must be omitted rather
        // than left pointing at a group that was never declared. A strict
        // player can reject the whole master over this, not just ignore it.
        const out = generateMasterPlaylist(
            [],
            SUBS,
            SEGMENT_BASE,
            PARAMS,
            8_000_000,
            SDR_H264,
            'h264',
            ITEM_ID,
            FILE_ID,
        );
        expect(out).not.toContain('TYPE=AUDIO');
        expect(out).not.toContain('AUDIO="audio"');
        // The sibling group is unaffected — it has real declarations.
        expect(out).toContain('SUBTITLES="subs"');
    });

    it('still declares the AUDIO group when audio tracks exist', () => {
        const out = generateMasterPlaylist(
            AUDIO,
            SUBS,
            SEGMENT_BASE,
            PARAMS,
            8_000_000,
            SDR_H264,
            'h264',
            ITEM_ID,
            FILE_ID,
        );
        expect(out).toContain('AUDIO="audio"');
        expect(out.match(/TYPE=AUDIO/g)).toHaveLength(2);
    });

    it('PROBE: zero audio tracks', () => {
        expect(
            generateMasterPlaylist(
                [],
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                8_000_000,
                SDR_H264,
                'h264',
                ITEM_ID,
                FILE_ID,
            ),
        ).toMatchSnapshot();
    });
});

// ── muxed ─────────────────────────────────────────────────────────────────────

describe('generateMuxedMasterPlaylist — characterization', () => {
    const MEDIA_URI = `${SEGMENT_BASE}/index.m3u8?playSessionId=ps_1&hlsAudioMode=muxed`;

    it('kitchen sink: HDR10, subs, trickplay, synthetic iframes', () => {
        expect(
            generateMuxedMasterPlaylist(MEDIA_URI, 12_000_000, HDR10_HEVC, 'hevc', ALL_OPTIONS, {
                segmentBase: SEGMENT_BASE,
                params: PARAMS,
                trickplayInfo: TRICKPLAY,
                itemId: ITEM_ID,
                fileId: FILE_ID,
                subtitleTracks: SUBS,
            }),
        ).toMatchSnapshot();
    });

    it('minimal: no video info, no options, no rendition context', () => {
        expect(generateMuxedMasterPlaylist(MEDIA_URI, 5_000_000)).toMatchSnapshot();
    });

    it('Dolby Vision, mpegts container', () => {
        expect(
            generateMuxedMasterPlaylist(MEDIA_URI, 48_000_000, DOLBY_VISION, 'hevc', {
                ...ALL_OPTIONS,
                hlsContainer: 'mpegts',
            }).valueOf(),
        ).toMatchSnapshot();
    });

    // ── DIVERGENCE PROBE ──
    it('PROBE: subs + fileId, itemId ABSENT — muxed KEEPS the subtitle group (demux does not)', () => {
        const out = generateMuxedMasterPlaylist(
            MEDIA_URI,
            8_000_000,
            SDR_H264,
            'h264',
            ALL_OPTIONS,
            {
                segmentBase: SEGMENT_BASE,
                params: PARAMS,
                fileId: FILE_ID,
                subtitleTracks: SUBS,
                // itemId deliberately omitted
            },
        );
        // The asymmetry with the demux probe above is the whole point.
        expect(out).toContain('TYPE=SUBTITLES');
        expect(out).toMatchSnapshot();
    });

    it('PROBE: subs present, fileId ABSENT — muxed drops the subtitle group', () => {
        const out = generateMuxedMasterPlaylist(
            MEDIA_URI,
            8_000_000,
            SDR_H264,
            'h264',
            ALL_OPTIONS,
            {
                segmentBase: SEGMENT_BASE,
                params: PARAMS,
                subtitleTracks: SUBS,
            },
        );
        expect(out).not.toContain('TYPE=SUBTITLES');
        expect(out).toMatchSnapshot();
    });
});

// ── audio-only ────────────────────────────────────────────────────────────────

describe('generateAudioOnlyMasterPlaylist — characterization', () => {
    const MEDIA_URI = `${SEGMENT_BASE}/index.m3u8?playSessionId=ps_1&audioOnly=1`;

    it('with subtitles and fileId', () => {
        expect(
            generateAudioOnlyMasterPlaylist(
                MEDIA_URI,
                AUDIO_ONLY_BANDWIDTH,
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                FILE_ID,
            ),
        ).toMatchSnapshot();
    });

    it('minimal: defaults for everything after the bandwidth', () => {
        expect(generateAudioOnlyMasterPlaylist(MEDIA_URI, AUDIO_ONLY_BANDWIDTH)).toMatchSnapshot();
    });

    it('PROBE: subs present, fileId ABSENT — drops the subtitle group', () => {
        const out = generateAudioOnlyMasterPlaylist(
            MEDIA_URI,
            AUDIO_ONLY_BANDWIDTH,
            SUBS,
            SEGMENT_BASE,
            PARAMS,
        );
        expect(out).not.toContain('TYPE=SUBTITLES');
        expect(out).toMatchSnapshot();
    });

    // ── DIVERGENCE PROBE ──
    it('PROBE: fileId present but segmentBase EMPTY — emits root-relative subtitle URIs', () => {
        const out = generateAudioOnlyMasterPlaylist(
            MEDIA_URI,
            AUDIO_ONLY_BANDWIDTH,
            SUBS,
            '', // segmentBase default
            PARAMS,
            FILE_ID,
        );
        // muxed refuses to emit subtitles without a segmentBase; this one emits
        // them against the wrong root. Recorded, not fixed here.
        expect(out).toContain('URI="/subs_0/index.m3u8');
        expect(out).toMatchSnapshot();
    });
});

// ── muxed × TRANSCODED video info ─────────────────────────────────────────────
//
// The muxed master's PRIMARY production input is transcoded content — its own
// docstring says AVPlayer reaches it that way ("a tvOS client playing AV1 lands
// on delivery_path mse_hls"). Every fixture above is `isTranscoded: false`, and
// the behavioural suite's transcoded/HDR-preserved/outputHevcMain10 cases all
// run through the DEMUX generator. So the muxed master had zero byte-level
// coverage of the inputs it actually serves in production.
//
// This matters because the failure it guards is one this codebase has shipped
// twice: declaring hvc1.1.6 over a Main-10 bitstream (or the reverse) makes
// AVFoundation reject at start with CoreMediaErrorDomain 1718449215 ('fmt?').
// `resolveHevcMain10` exists in the module under test for exactly that reason.

describe('generateMuxedMasterPlaylist — transcoded inputs (the live path)', () => {
    const MEDIA_URI = `${SEGMENT_BASE}/index.m3u8?playSessionId=ps_1&hlsAudioMode=muxed`;

    const TRANSCODED_HDR_PRESERVED: MasterPlaylistVideoInfo = {
        codec: 'hevc',
        width: 3840,
        height: 2160,
        bitrate: 25_000_000,
        frameRate: 23.976,
        videoRange: 'HDR',
        videoRangeType: 'HDR10',
        isTranscoded: true,
        preserveHdr: true,
        outputHevcMain10: true,
    };

    const TRANSCODED_TONEMAPPED: MasterPlaylistVideoInfo = {
        codec: 'hevc',
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
        frameRate: 23.976,
        videoRange: 'HDR',
        videoRangeType: 'HDR10',
        isTranscoded: true,
        preserveHdr: false,
        outputHevcMain10: false,
    };

    it('HDR-preserved transcode (Main 10, VIDEO-RANGE kept)', () => {
        expect(
            generateMuxedMasterPlaylist(MEDIA_URI, 25_000_000, TRANSCODED_HDR_PRESERVED, 'hevc', {
                ...ALL_OPTIONS,
            }),
        ).toMatchSnapshot();
    });

    it('HDR→SDR tone-mapped transcode (Main, VIDEO-RANGE dropped)', () => {
        expect(
            generateMuxedMasterPlaylist(MEDIA_URI, 8_000_000, TRANSCODED_TONEMAPPED, 'hevc', {
                ...ALL_OPTIONS,
            }),
        ).toMatchSnapshot();
    });

    it('outputHevcMain10 flips the profile byte on an otherwise identical input', () => {
        // Pinned as a PAIR so the two cannot silently converge — that
        // convergence is the 'fmt?' bug, and a single snapshot would not show it.
        const main10 = generateMuxedMasterPlaylist(
            MEDIA_URI,
            8_000_000,
            { ...TRANSCODED_TONEMAPPED, outputHevcMain10: true },
            'hevc',
            ALL_OPTIONS,
        );
        const main8 = generateMuxedMasterPlaylist(
            MEDIA_URI,
            8_000_000,
            { ...TRANSCODED_TONEMAPPED, outputHevcMain10: false },
            'hevc',
            ALL_OPTIONS,
        );
        expect(main10).not.toEqual(main8);
        expect({ main10, main8 }).toMatchSnapshot();
    });

    it('copied audio (EAC3) reaches the CODECS string', () => {
        // ALL_OPTIONS has isAudioCopied:false, so `getAudioCodecString`'s
        // non-AAC branches were unreachable from every snapshot above.
        expect(
            generateMuxedMasterPlaylist(MEDIA_URI, 12_000_000, SDR_H264, 'h264', {
                ...ALL_OPTIONS,
                audioCodec: 'eac3',
                isAudioCopied: true,
            }),
        ).toMatchSnapshot();
    });
});

// ── video-info matrix across both video kinds ────────────────────────────────
//
// The snapshots above cover a narrow slice (HDR10 / DV profile 8.1 / SDR h264).
// These pin the assembled STREAM-INF tail for the rest of the reachable space,
// where the behavioural suite asserts individual attributes but never the
// assembled line.

const VIDEO_VARIANTS: Array<[string, MasterPlaylistVideoInfo]> = [
    [
        'DV profile 5 (dvh1 as the primary CODECS entry)',
        {
            codec: 'hevc',
            width: 3840,
            height: 2160,
            frameRate: 23.976,
            videoRange: 'HDR',
            videoRangeType: 'DOVI',
            dvProfile: 5,
            dvLevel: 6,
            level: 153,
        } as MasterPlaylistVideoInfo,
    ],
    [
        'DV profile 8 with SDR base layer (compat id 2)',
        {
            codec: 'hevc',
            width: 3840,
            height: 2160,
            frameRate: 23.976,
            videoRange: 'HDR',
            videoRangeType: 'DOVIWithSDR',
            dvProfile: 8,
            dvBlSignalCompatibilityId: 2,
            level: 153,
        } as MasterPlaylistVideoInfo,
    ],
    [
        'HLG',
        {
            codec: 'hevc',
            width: 3840,
            height: 2160,
            frameRate: 50,
            videoRange: 'HDR',
            videoRangeType: 'HLG',
            level: 153,
        } as MasterPlaylistVideoInfo,
    ],
    [
        'AV1 SDR',
        { codec: 'av1', width: 3840, height: 2160, frameRate: 23.976 } as MasterPlaylistVideoInfo,
    ],
    [
        'integer frame rate (formatting: 24.000 must render as 24)',
        { codec: 'h264', width: 1920, height: 1080, frameRate: 24 } as MasterPlaylistVideoInfo,
    ],
    [
        '10-bit SDR HEVC',
        {
            codec: 'hevc',
            width: 1920,
            height: 1080,
            frameRate: 23.976,
            bitDepth: 10,
            profile: 'Main 10',
            level: 120,
        } as MasterPlaylistVideoInfo,
    ],
];

describe.each(VIDEO_VARIANTS)('video-info matrix: %s', (_label, videoInfo) => {
    it('demux STREAM-INF tail', () => {
        expect(
            generateMasterPlaylist(
                AUDIO,
                SUBS,
                SEGMENT_BASE,
                PARAMS,
                20_000_000,
                videoInfo,
                videoInfo.codec,
                ITEM_ID,
                FILE_ID,
            ),
        ).toMatchSnapshot();
    });

    it('muxed STREAM-INF tail', () => {
        expect(
            generateMuxedMasterPlaylist(
                `${SEGMENT_BASE}/index.m3u8`,
                20_000_000,
                videoInfo,
                videoInfo.codec,
                ALL_OPTIONS,
            ),
        ).toMatchSnapshot();
    });
});
