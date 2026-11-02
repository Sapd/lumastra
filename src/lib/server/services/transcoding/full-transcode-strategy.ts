// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Full Transcode Strategy
 *
 * Handles FFmpeg argument building for complete local file processing.
 *
 * This mode processes everything through a single FFmpeg pipeline from a local file:
 * - GPU-accelerated video encoding when available
 * - HDR to SDR tonemapping or HDR10 preservation
 * - Perfect A/V sync (no dual-source issues)
 * - Best for seeking accuracy
 */

import { planStandaloneTranscode, type EffectiveVideoAction } from './effective-transcode-plan.js';
import { Logger } from '../../utils/logger.js';
import {
    buildVarStreamMap,
    buildHlsOutputPattern,
    isHlsCompatibleAudioCodec,
} from './hls-utils.js';
import { FFmpegArgsBuilder, getHwAccelFromEncoder } from './ffmpeg-args-builder.js';
import { splitIntoGopOutputs } from './gop-output-args.js';
import { hardwareDetection } from './hardware-detection.js';
import type { TranscodeStrategyResult, FullStrategyConfig } from './transcode-strategy.js';
import { classifyHdrSource, dvBaseLayerIsHdr } from './types.js';
import {
    asAbsoluteStreamIndex,
    defaultAudioAbsoluteIndex,
    resolveAudioTrackByAbsoluteIndex,
} from '$lib/shared/stream-index';
import { parseBitrateString, AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS } from './quality-cap.js';

const logger = Logger.for('FullTranscodeStrategy');

/**
 * Clamp an FFmpeg-style bitrate string ("192k") to a maximum bits/second —
 * used to keep a transcoded audio track inside its per-request quality-cap
 * reservation (see `qualityCapAudioReservationBps`). Leaves the string alone
 * when it is already within budget.
 */
function capAudioBitrateString(bitrateStr: string, maxBps: number): string {
    const bps = parseBitrateString(bitrateStr);
    if (bps > 0 && bps > maxBps) {
        return `${Math.max(1, Math.floor(maxBps / 1000))}k`;
    }
    return bitrateStr;
}

/**
 * Last line of defence against an `audioTracks` list that claims audio the FILE
 * does not have.
 *
 * Every audio step here trusts `audioTracks` as the description of the source:
 * the muxed branch guards on "did a track resolve?" and the demux branch maps
 * one `0:a:<i>` per entry. Both guards test the ARRAY, so a list with a
 * fabricated entry passes them and ffmpeg is asked to map an audio stream that
 * is not there — it exits 234 with "Stream map '' matches no streams" before
 * writing a single segment. That is not hypothetical: the preview path used to
 * synthesize a placeholder track whenever it found no audio rows in the
 * database, which killed the hover preview of every audio-less file (silent
 * films, and the video-only renditions this app ships deliberately).
 *
 * The root fix is to not fabricate tracks. This is the backstop, and it is
 * deliberately narrow: it acts ONLY when a probe is present AND reports zero
 * audio streams. In that case no entry in the list can be real, so dropping
 * them all is safe without knowing anything about index conventions. A probe
 * that merely disagrees about COUNT or ORDER is left alone — second-guessing it
 * would risk dropping a genuine track, which is a worse bug than the one this
 * prevents.
 *
 * With the list emptied, both branches already degrade to a working video-only
 * output: muxed maps and encodes no audio, and demux maps nothing while
 * `buildVarStreamMap([])` emits the video rendition alone. (Verified against
 * jellyfin-ffmpeg 7.1.4 — note that the trailing-`?` form ffmpeg's own error
 * message suggests does NOT rescue the demux branch, because `-var_stream_map`
 * still names the audio rendition that the `?` just dropped.)
 */
/**
 * How many audio tracks the strategy will really map: none when the probe
 * contradicts the list (see dropAudioTracksSourceDoesNotHave). Exported so the
 * GOP-mode gate (ffmpeg-transcode.service.ts) counts exactly what the args do.
 */
export function effectiveAudioTrackCount(
    config: Pick<FullStrategyConfig, 'audioTracks' | 'mediaSourceInfo'>,
): number {
    const probedStreams = config.mediaSourceInfo?.streams;
    // No probe ⇒ no ground truth to check against. Stay out of the way.
    if (!probedStreams || config.audioTracks.length === 0) return config.audioTracks.length;
    return probedStreams.some((s) => s.type === 'Audio') ? config.audioTracks.length : 0;
}

function dropAudioTracksSourceDoesNotHave(config: FullStrategyConfig): FullStrategyConfig {
    if (effectiveAudioTrackCount(config) === config.audioTracks.length) return config;

    logger.warn('Source has no audio streams — dropping phantom audio tracks', {
        localFilePath: config.localFilePath,
        discardedTrackCount: config.audioTracks.length,
        hlsAudioMode: config.hlsOutput?.hlsAudioMode ?? 'demux',
    });
    return { ...config, audioTracks: [] };
}

/**
 * Samples an audio encoder emits before the first real one (its "priming" or
 * initial padding). With source timestamps kept, the first packet of an encoded
 * track sits that far BEFORE the input's start. Codecs not listed get no trim:
 * their priming is unknown here, and an untrimmed track only risks the wrapped
 * first decode time the assembler now reads signed (see fmp4-timing.ts).
 */
export function encoderPrimingSamples(codec: string): number {
    switch (codec.toLowerCase()) {
        case 'aac':
            return 1024;
        case 'libfdk_aac':
            return 2048;
        case 'ac3':
        case 'eac3':
            return 256;
        case 'opus':
        case 'libopus':
            return 312;
        default:
            return 0;
    }
}

/**
 * Full transcode strategy for local file processing.
 *
 * Uses FFmpegArgsBuilder to construct arguments for complete local file
 * transcoding with GPU acceleration and HLS multi-audio output.
 */
export class FullTranscodeStrategy {
    readonly name = 'FullTranscodeStrategy';
    private anyAudioTranscoded = false;
    private anyAudioCopied = false;
    /** Audio outputs that are encoded (not copied), with their target codec. */
    private transcodedAudioOutputs: { outputIndex: number; codec: string }[] = [];
    /** Whether the last buildArgs produced the GOP-mode two-output layout. */
    private lastGopSplit = false;

    /**
     * Build FFmpeg arguments for full local file processing.
     */
    buildArgs(rawConfig: FullStrategyConfig): TranscodeStrategyResult {
        this.anyAudioTranscoded = false;
        this.anyAudioCopied = false;
        this.transcodedAudioOutputs = [];
        this.lastGopSplit = false;

        const plan = rawConfig.effectivePlan ?? planStandaloneTranscode(rawConfig);
        const config = dropAudioTracksSourceDoesNotHave({
            ...rawConfig,
            effectivePlan: plan,
            tonemappingAlgorithm: plan.tonemappingAlgorithm,
            decision: plan.decision,
            videoDisabled: plan.videoDisabled,
            subtitleBurnIn: plan.subtitleBurnIn,
            segmentDuration: plan.segmentDuration,
            startTimeSeconds: plan.startTimeSeconds,
            startNumber: plan.startNumber,
            ...plan.caps,
        });
        const { audioTracks, decision } = config;
        const builder = new FFmpegArgsBuilder();
        if (plan.video.action === 'drop') return this.buildAudioOnlyArgs(builder, config);
        const videoAction = plan.video;
        const tonemapBurnInToSdr = plan.tonemapBurnInToSdr;
        if (videoAction.action === 'copy') {
            builder.setVideoCopy();
        }

        logger.info('Building full mode FFmpeg arguments', {
            localFilePath: config.localFilePath,
            useGpu: decision?.useGpu ?? false,
            gpuEncoder: decision?.gpuEncoder,
            videoAction: videoAction.action,
            audioAction: decision?.audioAction,
            needsTonemapping: decision?.needsTonemapping,
            subtitleBurnIn: config.subtitleBurnIn
                ? {
                      index: config.subtitleBurnIn.absoluteIndex,
                      codec: config.subtitleBurnIn.codec,
                  }
                : undefined,
        });

        // ================================================================
        // Hardware acceleration
        // ================================================================

        // Derive hwaccel type from encoder to ensure compatibility
        // e.g., hevc_nvenc requires cuda hwaccel, hevc_qsv requires qsv hwaccel
        if (decision?.useGpu && decision.gpuEncoder) {
            const hwAccelType = getHwAccelFromEncoder(decision.gpuEncoder);
            if (hwAccelType) {
                const softwareDecodeBridge =
                    config.forceSoftwareDecodeBridge === true ||
                    // Subtitle burn-in composites on the CPU and then hwuploads the
                    // frames to the QSV encoder surface. That upload needs a
                    // -filter_hw_device, which only the software-decode-bridge path
                    // sets up ("-init_hw_device qsv=qs@va -filter_hw_device qs").
                    // Burn-in always software-decodes anyway (the overlay is CPU),
                    // so it IS a software-decode bridge — force it for QSV or the
                    // hwupload fails with "a hardware device reference is required".
                    (!!config.subtitleBurnIn && hwAccelType === 'qsv') ||
                    !hardwareDetection.isSourceHardwareDecodable(
                        hwAccelType,
                        config.videoInfo?.codec,
                        config.videoInfo?.bitDepth,
                    );
                // AMD VA-API can't hardware tone-map HDR — when we'll tonemap on a
                // vaapi backend whose driver lacks HDR VPP, route the whole path
                // through software (decode + tonemapx) and upload the SDR result.
                const vaapiSoftwareTonemap =
                    hwAccelType === 'vaapi' &&
                    !!decision.needsTonemapping &&
                    !hardwareDetection.supportsVaapiHdrTonemap();
                builder.enableHwAccel(
                    hwAccelType,
                    hwAccelType === 'vaapi' ? config.vaapiDevice : undefined,
                    { softwareDecodeBridge, vaapiSoftwareTonemap },
                );
                logger.debug('Hardware acceleration derived from encoder', {
                    encoder: decision.gpuEncoder,
                    hwAccelType,
                    sourceCodec: config.videoInfo?.codec,
                    softwareDecodeBridge,
                    vaapiSoftwareTonemap,
                });
            }
        }

        // ================================================================
        // Input file with seeking
        // ================================================================

        // Bound input read length (previews). Must be set before add*Input* so
        // the `-t` lands as an input option ahead of `-i`.
        if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
            builder.setMaxInputDuration(config.maxDurationSeconds);
        }

        if (config.useConcatDemuxer) {
            // Split-file playback: use FFmpeg concat demuxer.
            // localFilePath points to a temp file listing all parts:
            //   file '/path/to/Part1.mkv'
            //   file '/path/to/Part2.mkv'
            builder.addConcatInputFile(config.localFilePath, config.startTimeSeconds);
        } else {
            builder.addInputFile(config.localFilePath, config.startTimeSeconds);
        }

        // ================================================================
        // Stream mapping
        // ================================================================

        // Map video stream (first video in file)
        builder.mapVideo(0, 0);

        const isMuxedAudio = config.hlsOutput?.hlsAudioMode === 'muxed';

        if (isMuxedAudio) {
            // Muxed mode: map only one audio track into the output.
            // hlsAudioTrackIndex is the ABSOLUTE ffmpeg stream index (includes
            // video/subs) — the canonical wire convention sent by BOTH the Lumastra
            // player and Jellyfin clients. mapAudio() needs the 0-based array
            // position, so resolve absolute -> position (fallback: first track).
            // audioTracks[].index holds the absolute index (see media-probe.service).
            // With no requested index, fall back to the FILE'S DEFAULT track —
            // not absolute 0, which is the video stream and matches nothing.
            // The same expression appears at the audio-only rung and at the
            // audio-encoding step; all three must stay identical.
            const requestedAbsolute = asAbsoluteStreamIndex(
                config.hlsOutput?.hlsAudioTrackIndex ?? defaultAudioAbsoluteIndex(audioTracks),
            );
            const resolved = resolveAudioTrackByAbsoluteIndex(audioTracks, requestedAbsolute);
            logger.info('Muxed HLS selected audio track', {
                requestedAbsoluteIndex: requestedAbsolute,
                mappedArrayIndex: resolved.position,
                matched: resolved.matched,
                streamIndex: resolved.track?.index,
                language: resolved.track?.language,
                title: resolved.track?.displayTitle,
            });
            // Only map when a track actually exists — keep this consistent with the
            // audio-encoding step below, which skips empty audioTracks. Mapping a
            // nonexistent 0:a:0 would make ffmpeg fail with "matches no streams".
            if (resolved.track) {
                builder.mapAudio(0, resolved.position);
            }
        } else {
            // Demux mode: map all audio streams sequentially
            // We use 0-based audio-relative indices (0:a:0, 0:a:1, etc.)
            // NOT Jellyfin's global stream index (which includes video streams)
            // The audioTracks array already contains the tracks we want in order
            //
            // An empty list is the video-only case and needs no guard of its
            // own: nothing is mapped here, and buildVarStreamMap([]) emits the
            // video rendition alone, so the two stay consistent and ffmpeg
            // produces a silent preview. What this branch cannot survive is a
            // list that OVERSTATES the source — see
            // dropAudioTracksSourceDoesNotHave. Do not "fix" that by appending
            // a trailing `?` to the map: `-var_stream_map` still names the
            // rendition, so ffmpeg fails with "Nothing was written into output
            // file" instead of degrading (measured on jellyfin-ffmpeg 7.1.4).
            for (let i = 0; i < audioTracks.length; i++) {
                builder.mapAudio(0, i);
            }
        }

        // ================================================================
        // Video encoding (resolve once, use everywhere)
        // ================================================================

        this.applyVideoEncoding(builder, config, videoAction);

        // ================================================================
        // HDR handling
        // ================================================================

        this.configureHdrHandling(builder, config);

        // ================================================================
        // Deinterlacing
        // ================================================================

        if (this.shouldDeinterlace(config, videoAction)) {
            if (builder.supportsDeinterlacing()) {
                builder.enableDeinterlacing();
            } else {
                logger.warn('Interlaced source: no deinterlacer for this backend, encoding as-is', {
                    hwAccel: builder.getActiveFilterHwAccel(),
                });
            }
        }

        // ================================================================
        // Audio encoding
        // ================================================================

        this.configureAudioEncoding(builder, config);

        // ================================================================
        // Audio filters (only when transcoding audio)
        // ================================================================

        // Check if any audio track was transcoded (set by configureAudioEncoding)
        const anyAudioTranscoded = this.anyAudioTranscoded;

        if (anyAudioTranscoded) {
            // Audio boost for downmixing (only works when transcoding). Next to a
            // copied track it has to go on the encoded streams alone: the global
            // -af would make ffmpeg refuse the copies.
            if (config.audioBoost !== 1.0) {
                if (this.anyAudioCopied) {
                    for (const { outputIndex } of this.transcodedAudioOutputs) {
                        builder.addStreamAudioFilter(outputIndex, `volume=${config.audioBoost}`);
                    }
                } else {
                    builder.setAudioBoost(config.audioBoost);
                }
            }

            // Apply async resampling filter to fix timestamp drift between audio and video.
            // IMPORTANT: -af is a global flag — it applies to ALL audio outputs including
            // copy streams. FFmpeg errors with "Filtering and streamcopy cannot be used
            // together" if any audio track is being copied. Only apply when ALL audio
            // tracks are transcoded (no copies).
            if (!this.anyAudioCopied) {
                builder.enableAsyncResample();
            }

            // With the video copied the output keeps source timestamps (-copyts,
            // -avoid_negative_ts disabled), and an encoder's priming samples put
            // the FIRST packet of every transcoded track at a negative decode
            // time: AAC's 1024 samples became tfdt 2^64 − 1024 in the first fMP4
            // part (TNG S3E16 on prod, 2026-11-02, DTS → AAC next to copied AC3).
            // The GOP assembler then keyed that part to the last grid entry and
            // called entries 0 and 1 complete before their parts existed; AVPlayer
            // froze on that rendition. Dropping the priming's worth of samples
            // moves the first packet to decode time 0 and keeps sync exact. Only
            // the encoded streams are filtered: a copied stream cannot be.
            //
            // Only for a run that starts at the file's beginning: a seek generation
            // starts at a keyframe T, its first packet sits at T − priming, which
            // is positive and keys to the entry before T as the assembler expects;
            // trimming there would drop real audio at every seam instead.
            if (videoAction.action === 'copy' && !config.startTimeSeconds) {
                if (this.anyAudioCopied) {
                    for (const { outputIndex, codec } of this.transcodedAudioOutputs) {
                        const priming = encoderPrimingSamples(codec);
                        if (priming > 0) {
                            builder.addStreamAudioFilter(
                                outputIndex,
                                `atrim=start_sample=${priming}`,
                            );
                        } else {
                            logger.warn(
                                'Unknown encoder priming: first packet may start before 0',
                                {
                                    codec,
                                    outputIndex,
                                },
                            );
                        }
                    }
                } else {
                    // Every track is encoded with the same target codec: one trim in
                    // the shared chain, after the async resample.
                    const priming = encoderPrimingSamples(
                        this.transcodedAudioOutputs[0]?.codec ?? config.audioCodec ?? 'aac',
                    );
                    if (priming > 0) builder.addAudioFilter(`atrim=start_sample=${priming}`);
                }
            }
        }

        // ================================================================
        // Subtitle burn-in (overlay filter)
        // ================================================================

        if (config.subtitleBurnIn) {
            builder.enableSubtitleBurnIn(config.subtitleBurnIn.absoluteIndex, {
                text: config.subtitleBurnIn.text,
                tonemapHdrToSdr: tonemapBurnInToSdr,
            });
            logger.info('Subtitle burn-in enabled', {
                absoluteIndex: config.subtitleBurnIn.absoluteIndex,
                codec: config.subtitleBurnIn.codec,
                tonemapHdrToSdr: tonemapBurnInToSdr,
            });
        }

        const args = this.appendHlsOutputArgs(builder, config, videoAction);

        const description = decision?.useGpu
            ? `Full mode: GPU-accelerated (${decision.gpuEncoder})`
            : 'Full mode: CPU encoding';

        logger.debug('Built full mode FFmpeg args', {
            argCount: args.length,
            useGpu: decision?.useGpu ?? false,
            gpuEncoder: decision?.gpuEncoder,
        });

        return { args, description, gopSplit: this.lastGopSplit };
    }

    /**
     * Whether the source is interlaced and this job re-encodes its video. The
     * video stream's isInterlaced comes from ffprobe's field_order
     * (probeForTranscode → playback/preview mediaSourceInfo). For an encode,
     * deinterlacing is not optional: the encoders flag their output
     * progressive, so leftover fields show as combing on every motion. A
     * stream copy is left alone — ffmpeg refuses `-vf` with `-c:v copy`.
     */
    private shouldDeinterlace(
        config: FullStrategyConfig,
        videoAction: { action: 'copy' | 'transcode' },
    ): boolean {
        return (
            videoAction.action === 'transcode' &&
            config.deinterlaceMethod !== 'none' &&
            config.mediaSourceInfo?.streams.find((s) => s.type === 'Video')?.isInterlaced === true
        );
    }

    /**
     * Build FFmpeg arguments for the audio-only rung: drop the video stream
     * entirely and encode a single audio track to fixed AAC-LC stereo at
     * 128k. No copy fast-path — always transcode, so the manifest's
     * advertised codec always matches what's in the segments.
     *
     * Always forces the muxed HLS output shape (single flat index.m3u8, no
     * var_stream_map, no master playlist) regardless of the source config's
     * hlsAudioMode: `buildVarStreamMap()` unconditionally appends a `v:0`
     * video variant entry to the demux var_stream_map, which hlsenc cannot
     * resolve once `-vn` has dropped the video stream — FFmpeg exits
     * EINVAL before writing a byte. A later task's single-rendition
     * audio-only master playlist is expected to agree with this shape.
     *
     * Track selection mirrors the normal path's own muxed-mode resolution
     * (resolve the requested, or default/first, track by absolute stream
     * index) rather than mapping every track — an audio-only rung is one
     * flat rendition, not a multi-track demux structure.
     */
    private buildAudioOnlyArgs(
        builder: FFmpegArgsBuilder,
        config: FullStrategyConfig,
    ): TranscodeStrategyResult {
        const { audioTracks } = config;

        // Bound input read length (previews). Must be set before add*Input* so
        // the `-t` lands as an input option ahead of `-i` — same as the normal
        // path above.
        if (config.maxDurationSeconds && config.maxDurationSeconds > 0) {
            builder.setMaxInputDuration(config.maxDurationSeconds);
        }

        if (config.useConcatDemuxer) {
            builder.addConcatInputFile(config.localFilePath, config.startTimeSeconds);
        } else {
            builder.addInputFile(config.localFilePath, config.startTimeSeconds);
        }

        builder.disableVideo();

        // audioTracks may legitimately be empty (e.g. a source with no audio
        // stream at all reaching this rung) — resolveAudioTrackByAbsoluteIndex
        // returns an undefined track in that case, and nothing is mapped or
        // encoded below.
        const requestedAbsolute = asAbsoluteStreamIndex(
            config.hlsOutput?.hlsAudioTrackIndex ?? defaultAudioAbsoluteIndex(audioTracks),
        );
        const resolved = resolveAudioTrackByAbsoluteIndex(audioTracks, requestedAbsolute);
        if (resolved.track) {
            builder.mapAudio(0, resolved.position);
            builder.setAudioCodec('aac', 0, { bitrate: '128k', channels: 2 });
            // Force-downmixing every source to fixed stereo is exactly the
            // case AUDIO_BOOST exists for (see config.ts: "Audio boost when
            // downmixing") — apply it same as the normal transcode path does.
            if (config.audioBoost !== 1.0) {
                builder.setAudioBoost(config.audioBoost);
            }
        }

        const forcedConfig: FullStrategyConfig = {
            ...config,
            hlsOutput: { ...config.hlsOutput, hlsAudioMode: 'muxed' },
        };
        const args = this.appendHlsOutputArgs(builder, forcedConfig, { action: 'transcode' });
        return { args, description: 'audio-only (video dropped)' };
    }

    /**
     * Append the HLS muxer/segment output tail: output options, HLS
     * flags/config, the muxed-vs-demux var_stream_map branch, and the
     * output pattern. Extracted verbatim from `buildArgs` so a later
     * strategy can reuse the same tail.
     */
    private appendHlsOutputArgs(
        builder: FFmpegArgsBuilder,
        config: FullStrategyConfig,
        videoAction: { action: 'copy' | 'transcode' },
    ): string[] {
        const { outputDir, segmentDuration, audioTracks } = config;

        // ================================================================
        // Output options
        // ================================================================

        const gop = isVideoCopyGop(config, videoAction);
        if (gop) builder.forceCopyTimestamps();
        if (config.sourceTimestamps) builder.keepSourceTimestamps();
        builder.addOutputOptions();
        builder.enableStrict(); // For Dolby Vision support

        // HLS output configuration
        //
        // split_by_time is NOT used on any path, and the two flags must never be
        // sent together. Measured against prod's ffmpeg (jellyfin-ffmpeg 7.1.4,
        // reproduced on 8.1.2), 23.976 fps / 29.5 s source, forced IDRs every 6 s:
        //
        //   independent_segments+…+split_by_time → segments 6.006 ×4 + 5.5055,
        //                                          NO #EXT-X-INDEPENDENT-SEGMENTS
        //   independent_segments only            → identical segments, tag PRESENT
        //   split_by_time only                   → identical segments, no tag
        //
        // So split_by_time genuinely suppresses independent_segments (as
        // ec9c961da found), but it buys nothing once that commit's forced IDRs
        // land a keyframe on every boundary — ffmpeg's default keyframe split
        // produces byte-identical segmentation. Choosing split_by_time therefore
        // only cost the tag that ADVERTISES the independence those IDRs create,
        // which is the very thing the commit set out to give the Apple TV client.
        //
        // Copy (remux) never had forced IDRs and already relied on splitting at
        // source keyframes — unchanged, and equally correct here.
        //
        // Audio-only (buildAudioOnlyArgs passes action:'transcode' with -vn) was
        // measured too: identical segmentation either way, and ffmpeg emits no
        // independence tag for an audio-only playlist at all.
        const isVideoCopy = videoAction.action === 'copy';
        const hlsFlags = ['independent_segments', 'program_date_time', 'temp_file'];

        const hlsContainer = config.hlsOutput?.hlsContainer ?? 'fmp4';
        const hlsAudioMode = config.hlsOutput?.hlsAudioMode ?? 'demux';
        const hlsPlaylistType = config.hlsOutput?.hlsPlaylistType ?? 'event';
        const isMuxed = hlsAudioMode === 'muxed';
        const isMpegTs = hlsContainer === 'mpegts';

        builder.configureHlsOutput({
            segmentDuration,
            playlistType: hlsPlaylistType,
            segmentType: hlsContainer,
            initFilename: isMpegTs ? undefined : isMuxed ? 'init_0.mp4' : 'init_%v.mp4',
            flags: hlsFlags,
            // In transcode mode, all streams share the same segment cadence,
            // so -start_number aligns file names with the manifest directly.
            // In remux/copy mode, video has different segment duration (~10s
            // vs 6s audio), so we keep -start_number 0 and translate indices
            // in the segment handler.
            startNumber: !isVideoCopy ? config.startNumber : undefined,
        });

        if (isMuxed) {
            // Muxed mode: no var_stream_map, no master playlist from FFmpeg.
            // A single output with video + one audio track muxed together.
            // Master playlist will be generated by our code instead.
        } else {
            // Demux mode: separate audio/video renditions
            const streamMapParts = buildVarStreamMap(audioTracks);
            builder.setVarStreamMap(streamMapParts.join(' '));
            builder.setMasterPlaylist('master.m3u8');
        }

        // Get args from builder
        const args = builder.build();

        // Output patterns (added after build())
        args.push(
            ...buildHlsOutputPattern(outputDir, {
                container: hlsContainer,
                audioMode: hlsAudioMode,
            }),
        );

        if (gop) {
            this.lastGopSplit = true;
            return splitIntoGopOutputs(args, {
                outputDir,
                audioTrackCount: audioTracks.length,
                videoStartKeyframe: gop.videoStartKeyframe,
            });
        }
        return args;
    }

    /**
     * Configure video encoding based on transcode decision.
     *
     * Phase 1: Resolve what to do (single decision point, no ambiguity)
     * Phase 2: Execute the resolved action (apply encoder settings, HDR, etc.)
     *
     * For Apple TV 4K compatibility:
     * - HEVC: Main 10 profile, Level 5.1 (supports 4K60 HDR)
     * - H.264: High profile, Level 4.0 (broad compatibility)
     */
    private applyVideoEncoding(
        builder: FFmpegArgsBuilder,
        config: FullStrategyConfig,
        resolved: EffectiveVideoAction,
    ): void {
        logger.info('Video encoding resolved', {
            action: resolved.action,
            encoder: resolved.action === 'transcode' ? resolved.encoder : undefined,
            source: resolved.action === 'transcode' ? resolved.source : undefined,
            sourceCodec: config.videoInfo?.codec,
            outputCodec: config.videoInfo?.outputCodec,
        });

        if (resolved.action === 'copy') {
            builder.copyVideo();

            // The sample-entry 4CC MUST match what the master playlist puts in CODECS,
            // or AVPlayer finds no decodable video variant, plays the audio group and
            // stalls on a black screen. Keep this in lockstep with
            // getVideoCodecString() in hls-master-playlist.ts.
            //
            // Dolby Vision DOES survive the copy: ffmpeg writes the `dvvC` box into the
            // fMP4 init segment (confirmed on jellyfin-ffmpeg 7.1.4). Note `-strict
            // unofficial` must be an OUTPUT option for that — placed before `-i` it
            // configures the decoder and the muxer silently omits `dvvC`.
            const dvProfile = config.videoInfo?.dvProfile;
            const dvCrossCompatible =
                dvProfile !== undefined &&
                dvBaseLayerIsHdr(config.videoInfo?.dvBlSignalCompatibilityId ?? 0, dvProfile);

            if (dvProfile !== undefined && !dvCrossCompatible) {
                // Profiles 5/7: no backward-compatible base layer, so the DV codec is
                // the PRIMARY entry in CODECS. Sample entry must match it.
                // dvh1 = out-of-band parameter sets (fMP4), dvhe = in-band (TS).
                builder.setVideoTag(this.outputIsFmp4(config) ? 'dvh1' : 'dvhe');
            } else if (this.outputIsHevc(config) && this.outputIsFmp4(config)) {
                // Copying HEVC (parameter sets in-band, e.g. from an MKV source) into
                // fMP4 makes ffmpeg default to a `hev1` sample entry, while the manifest
                // advertises `hvc1` (Apple HLS requires it). The mismatch makes strict
                // MSE decoders — notably Firefox on Linux — open an `hvc1` SourceBuffer,
                // receive `hev1` segments, decode the first GOP, then stall forever.
                // macOS VideoToolbox tolerates it, which is why it only reproduced on
                // some clients. (Mirrors Jellyfin's `-tag:v hvc1` on its remux path.)
                //
                // Cross-compatible DV (profile 8, and profile 10 over AV1) lands here on
                // purpose. Its base layer is ordinary HDR10/HLG, so per Apple's HLS
                // authoring spec the track is tagged `hvc1` and DV is advertised out of
                // band via SUPPLEMENTAL-CODECS, backed by the `dvvC` box — that is what
                // lets a non-DV decoder fall back to the base layer. Tagging it `dvh1`
                // (as we used to) contradicted the `hvc1` in CODECS and was the cause of
                // the audio-only black screen on Apple TV.
                builder.setVideoTag('hvc1');
            }

            // An `hvc1`/`dvh1` sample entry REQUIRES the parameter sets (VPS/SPS/PPS)
            // out-of-band in the `hvcC` box. Plenty of MKVs carry only a 23-byte
            // CodecPrivate stub — an hvcC header with zero parameter-set arrays — and
            // keep the real parameter sets in-band. Stream-copying those while forcing
            // `hvc1` writes the stub straight into `hvcC`, producing a track with no
            // VPS/SPS/PPS at all: ffprobe reports profile/pix_fmt `unknown` and level
            // -99, and AVPlayer rejects it outright (CoreMediaErrorDomain -19601,
            // audio plays over a black screen). "Red Notice" is exactly this shape.
            //
            // `hevc_metadata` parses the in-band parameter sets and rebuilds proper
            // extradata, so the muxer emits a conformant hvcC (23 -> 290 bytes on that
            // file). It is a bitstream filter, so this stays a copy — no re-encode.
            // Sources that already carry good extradata are unaffected (verified: DV
            // P8.1 stayed at 183 bytes with its `dvvC` intact, DV P5 kept `dvcC`).
            //
            // MPEG-TS is excluded: it carries parameter sets in-band by design and has
            // no sample entry, so there is nothing to reconstruct.
            if (this.outputIsHevc(config) && this.outputIsFmp4(config)) {
                builder.setVideoBitstreamFilter('hevc_metadata');
            }
            return;
        }

        // === Transcoding: apply encoder, profile, keyframes, bitrate, resolution ===
        const { encoder, isH264, isHevc, isAv1, isGpu } = resolved;

        // Profile/Level: H.264 and HEVC only (AV1 doesn't use these)
        // Software HEVC: always main10 (jellyfin-ffmpeg libx265 is 10-bit only)
        // GPU HEVC: main10 for HDR, main for SDR
        const isHdr =
            config.decision?.preserveHdr10 ||
            config.decision?.outputVideoRange === 'HDR10' ||
            config.decision?.outputVideoRange === 'HLG';
        // A software fallback from a GPU encoder keeps the GPU encoder's profile:
        // the master already advertised it (resolveHevcMain10 is false for a GPU job).
        const keepGpuHevcProfile = (isGpu || !!config.softwareEncodeFallback) && !isHdr;
        const profile = isAv1
            ? undefined
            : isHevc
              ? keepGpuHevcProfile
                  ? 'main'
                  : 'main10'
              : 'high';
        // H.264 Level 4.0 caps at ~2048x1024; 4K sources need Level 5.1
        const sourceWidth = config.videoInfo?.width ?? 1920;
        const h264Level = sourceWidth > 2048 ? '5.1' : '4.0';
        const level = isAv1 ? undefined : isHevc ? '5.1' : h264Level;

        const crf = isH264 ? config.h264Crf : isHevc ? config.h265Crf : isAv1 ? 30 : 23;

        // Whether THIS path will emit an HDR→SDR tone-map: the outputCodec path
        // tonemaps an HDR source to H.264 (HEVC preserves HDR10 instead). Needed
        // before enableHwAccel so AMD VA-API (no hardware HDR VPP) routes through
        // the software tone-map path. The main decision.needsTonemapping path is
        // handled at the first enableHwAccel site in buildArgs.
        const codecRequestHdr = config.effectivePlan?.codecRequestHdr;
        const willTonemap =
            !!config.decision?.needsTonemapping || codecRequestHdr?.kind === 'tonemap';

        // Enable hwaccel when GPU encoder is resolved from outputCodec path
        // (decision engine may not have set it if it said "copy" for video)
        if (isGpu && !builder.hasHwAccelEnabled()) {
            const hwAccelType = getHwAccelFromEncoder(encoder);
            if (hwAccelType) {
                const softwareDecodeBridge =
                    config.forceSoftwareDecodeBridge === true ||
                    // Subtitle burn-in composites on the CPU and then hwuploads the
                    // frames to the QSV encoder surface. That upload needs a
                    // -filter_hw_device, which only the software-decode-bridge path
                    // sets up ("-init_hw_device qsv=qs@va -filter_hw_device qs").
                    // Burn-in always software-decodes anyway (the overlay is CPU),
                    // so it IS a software-decode bridge — force it for QSV or the
                    // hwupload fails with "a hardware device reference is required".
                    (!!config.subtitleBurnIn && hwAccelType === 'qsv') ||
                    !hardwareDetection.isSourceHardwareDecodable(
                        hwAccelType,
                        config.videoInfo?.codec,
                        config.videoInfo?.bitDepth,
                    );
                const vaapiSoftwareTonemap =
                    hwAccelType === 'vaapi' &&
                    willTonemap &&
                    !hardwareDetection.supportsVaapiHdrTonemap();
                builder.enableHwAccel(
                    hwAccelType,
                    hwAccelType === 'vaapi' ? config.vaapiDevice : undefined,
                    { softwareDecodeBridge, vaapiSoftwareTonemap },
                );
            }
        }

        // VBV cap (Mbps). Set for previews AND for a per-request quality cap
        // (?maxBitrate on the HLS master URL — see quality-cap.ts); both flow
        // through the same `maxVideoBitrateMbps` field so this stays a single
        // authoritative cap. Undefined leaves real playback's rate control
        // (CRF / dynamic bitrate) exactly as-is.
        const previewBitrate =
            config.maxVideoBitrateMbps && config.maxVideoBitrateMbps > 0
                ? config.maxVideoBitrateMbps
                : undefined;

        if (isGpu) {
            builder.setVideoCodec(encoder, {
                nvencPreset: config.nvencPreset,
                nvencTune: config.nvencTune,
                nvencRc: config.nvencRc,
                nvencCq: config.nvencCq,
                qsvPreset: config.encodingPreset,
                // VBV cap for previews (adds -b:v/-maxrate/-bufsize); GPU encoders
                // apply it alongside their preset/quality control.
                ...(previewBitrate ? { bitrate: previewBitrate, maxBitrate: previewBitrate } : {}),
                profile,
                level,
                bframes: 3,
            });
        } else {
            builder.setVideoCodec(encoder, {
                preset: config.encodingPreset,
                // Prefer the VBV cap over CRF for previews: libx264 ignores -b:v
                // when -crf is also set, so a capped preview passes `bitrate`
                // (ABR at the cap) INSTEAD of `crf`. Real playback keeps CRF.
                ...(previewBitrate
                    ? { bitrate: previewBitrate, maxBitrate: previewBitrate }
                    : { crf }),
                profile,
                level,
                bframes: 3,
            });
        }

        // Encoded HEVC into fMP4 also defaults to a `hev1` sample entry, while the
        // HLS manifest advertises `hvc1`. Tag it to match so strict MSE decoders
        // (Firefox/Linux) don't stall on the mismatch — same rationale as the copy
        // branch above.
        if (isHevc && this.outputIsFmp4(config)) {
            builder.setVideoTag('hvc1');
        }

        // Keyframes at segment boundaries for proper HLS alignment. A field-rate
        // deinterlacer doubles the output frame rate, and the GOP is in frames.
        const frameRate =
            (config.videoInfo?.frameRate || 24) *
            (this.shouldDeinterlace(config, resolved) && builder.deinterlaceDoublesRate() ? 2 : 1);
        builder.setKeyframeInterval(config.segmentDuration, frameRate);
        // A GOP limit alone permits encoders to place a keyframe late. Force one at
        // every HLS boundary so a client can begin decoding immediately after seeking.
        builder.forceKeyframesAtInterval(config.segmentDuration);

        if (codecRequestHdr?.kind === 'tonemap') {
            builder.enableTonemapping({
                algorithm: codecRequestHdr.algorithm,
                useGpu: isGpu,
                gpuType: builder.getActiveFilterHwAccel(),
            });
        } else if (codecRequestHdr?.kind === 'preserve') {
            builder.enableHdr10Output({ outputRange: codecRequestHdr.range });
        }

        // H.264 (libx264) only supports 8-bit (yuv420p).
        // 10-bit sources decode to yuv420p10le which crashes libx264.
        // Skip when using CUDA hwaccel — scale_cuda handles format conversion in GPU space.
        if (isH264 && !builder.hasHwAccelEnabled()) {
            builder.setPixelFormat('yuv420p');
        }
        // libx265 would pick 10-bit for a 10-bit source; the SDR HEVC fallback
        // must stay 8-bit Main like the NVENC output the master described.
        if (isHevc && !isHdr && !!config.softwareEncodeFallback && !builder.hasHwAccelEnabled()) {
            builder.setPixelFormat('yuv420p');
        }

        // Bitrate: preview VBV cap > explicit config > QSV auto-calculate > CRF
        if (previewBitrate) {
            // The preview cap was already applied as -b:v/-maxrate/-bufsize by
            // setVideoCodec's `bitrate` option above. Skip the source-derived
            // recalculation below — for a QSV preview it would call
            // setVideoBitrate() again with a bitrate computed from the (huge)
            // 4K source, and FFmpeg honours the last -b:v, silently overriding
            // the cap (the exact fat-segment bug the cap exists to fix).
        } else if (config.videoBitrateMbps > 0) {
            builder.setVideoBitrate(config.videoBitrateMbps);
        } else if (isGpu && encoder.includes('qsv')) {
            const sourceBitrate = config.videoInfo?.bitrate || 0;
            const sourceCodec = config.videoInfo?.codec?.toLowerCase() || '';
            const targetCodecName = isHevc ? 'hevc' : isH264 ? 'h264' : 'av1';
            const calculatedBitrate = this.calculateTranscodeBitrate(
                sourceBitrate,
                sourceCodec,
                targetCodecName,
                config.videoInfo?.width || 1920,
            );
            logger.debug('Calculated QSV bitrate from source', {
                sourceBitrate,
                sourceCodec,
                targetCodecName,
                calculatedBitrateMbps: calculatedBitrate,
            });
            builder.setVideoBitrate(calculatedBitrate);
        }

        // Resolution limit
        if (config.maxWidth > 0 && config.maxHeight > 0) {
            builder.setVideoScale(config.maxWidth, config.maxHeight);
        }

        // Ensure even dimensions when transcoding (not when scaling is already set).
        // H.264/H.265 encoders require width and height divisible by 2.
        // Sources like 1920x1038 will fail without this.
        // Use scale_cuda when CUDA hwaccel is active (frames in GPU memory).
        if (config.maxWidth <= 0 && config.maxHeight <= 0) {
            if (builder.hasHwAccelEnabled()) {
                // Use the scaler that matches the ACTIVE FILTER backend — NOT the
                // encoder. They differ in NVENC's encoder-only bridge, where the
                // encoder is nvenc but frames are in system memory (filter backend
                // 'none' → software scale). On VA-API/QSV surfaces scale_cuda can't
                // run, the filtergraph produces zero frames, and the GPU encoder
                // fails to open (VA-API -38/-22). Mirrors setVideoScale()'s mapping.
                const hw = builder.getActiveFilterHwAccel();
                const evenScale =
                    hw === 'vaapi'
                        ? 'scale_vaapi=w=trunc(iw/2)*2:h=trunc(ih/2)*2'
                        : hw === 'qsv'
                          ? 'scale_qsv=w=trunc(iw/2)*2:h=trunc(ih/2)*2'
                          : hw === 'nvenc'
                            ? 'scale_cuda=w=trunc(iw/2)*2:h=trunc(ih/2)*2'
                            : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
                builder.addVideoFilter(evenScale);
            } else {
                builder.addVideoFilter('scale=trunc(iw/2)*2:trunc(ih/2)*2');
            }
        }
    }

    /**
     * True when the effective OUTPUT video codec is HEVC. For a copy this is the
     * source codec; a codec change is handled by the transcode branch, which
     * carries its own `isHevc` flag, so this only needs the source codec.
     */
    private outputIsHevc(config: FullStrategyConfig): boolean {
        const codec = config.videoInfo?.codec?.toLowerCase();
        if (!codec) return false;
        return codec.includes('hevc') || codec.includes('h265') || codec.includes('265');
    }

    /**
     * True when HLS segments are fMP4 (the default). The `hvc1`/`hev1` sample-entry
     * distinction is an ISO-BMFF concern; MPEG-TS carries no such 4CC tag, so the
     * `-tag:v hvc1` fix must not be applied there.
     */
    private outputIsFmp4(config: FullStrategyConfig): boolean {
        return (config.hlsOutput?.hlsContainer ?? 'fmp4') !== 'mpegts';
    }

    // Helper: check if video will be copied (used for HLS flags and even-dimension filter)
    /**
     * Configure HDR handling (tonemapping or preservation)
     */
    private configureHdrHandling(builder: FFmpegArgsBuilder, config: FullStrategyConfig): void {
        const { decision } = config;

        if (decision?.needsTonemapping) {
            // Convert HDR to SDR for non-HDR devices. Use the builder's active
            // filter backend (not config) so the NVENC encoder-only bridge
            // tonemaps in software while qsv/vaapi tonemap on the GPU surface.
            builder.enableTonemapping({
                algorithm: decision.tonemappingAlgorithm || config.tonemappingAlgorithm,
                useGpu: decision.useGpu,
                gpuType: builder.getActiveFilterHwAccel(),
            });
        } else if (decision?.preserveHdr10) {
            // Defensive guard: never inject HDR color metadata for SDR sources.
            // If the decision engine or planner has a bug, this prevents the
            // symptom (wrong colr box) from reaching the player.
            const sourceHdr = classifyHdrSource(
                config.videoInfo?.videoRange,
                config.videoInfo?.videoRangeType,
            );

            if (!sourceHdr.isHdr) {
                logger.warn('preserveHdr10=true but source is not HDR, skipping HDR output flags', {
                    videoRange: config.videoInfo?.videoRange,
                    videoRangeType: config.videoInfo?.videoRangeType,
                });
                return;
            }

            // Preserve HDR10/HLG quality when transcoding
            builder.enableHdr10Output({
                metadata: decision.hdr10Metadata,
                outputRange: decision.outputVideoRange === 'HLG' ? 'HLG' : 'HDR10',
            });
            logger.debug('HDR10 output preservation enabled', {
                outputRange: decision.outputVideoRange,
                hasMetadata: !!decision.hdr10Metadata,
            });
        }
    }

    /**
     * Calculate adaptive AAC bitrate based on source audio quality.
     *
     * AAC is more efficient than E-AC-3/DTS, so we can use 70% of source bitrate
     * while maintaining equivalent quality. We also apply reasonable limits to
     * prevent excessively low or high bitrates.
     *
     * @param sourceBitrate Source audio bitrate in bps (e.g., 768000 for 768 kbps)
     * @param channels Number of audio channels (2 for stereo, 6 for 5.1, etc.)
     * @param fallbackBitrate Fallback bitrate string if source is unknown (e.g., '256k')
     * @returns Target AAC bitrate string (e.g., '512k')
     */
    private calculateAdaptiveAudioBitrate(
        sourceBitrate: number | undefined,
        channels: number,
        fallbackBitrate: string,
    ): string {
        // If no source bitrate, use config fallback
        if (!sourceBitrate || sourceBitrate <= 0) {
            return fallbackBitrate;
        }

        // AAC is ~20-30% more efficient than E-AC-3/DTS
        // Use 70% of source bitrate for equivalent quality
        const targetBitrate = Math.round((sourceBitrate * 0.7) / 1000); // Convert to kbps

        // Apply channel-based limits
        const isStereo = channels <= 2;
        const minBitrate = isStereo ? 96 : 192; // Minimum quality threshold
        const maxBitrate = isStereo ? 256 : 512; // Maximum to keep file sizes reasonable

        const clampedBitrate = Math.max(minBitrate, Math.min(maxBitrate, targetBitrate));

        logger.debug('Calculated adaptive audio bitrate', {
            sourceBitrate: `${Math.round(sourceBitrate / 1000)}kbps`,
            channels,
            targetBitrate: `${targetBitrate}kbps`,
            clampedBitrate: `${clampedBitrate}kbps`,
            efficiency: '70%',
        });

        return `${clampedBitrate}k`;
    }

    /**
     * Configure audio encoding for all tracks
     *
     * Audio handling is per-track based on:
     * 1. Video action (remux vs transcode)
     * 2. Audio codec HLS compatibility
     *
     * Decision matrix:
     * - Video remux + audio HLS-compatible (E-AC-3, AAC, AC3) → Copy audio (preserve quality!)
     * - Video remux + audio incompatible (DTS, TrueHD) → Transcode audio to AAC
     * - Video transcode + any audio → Transcode audio to AAC (need sync filter)
     *
     * The async filter is only applied when at least one audio track is transcoded.
     */
    private configureAudioEncoding(builder: FFmpegArgsBuilder, config: FullStrategyConfig): void {
        const { audioTracks, decision } = config;
        const maxAudioChannels = 6; // Cap at 5.1 surround

        // Check if we're remuxing (video being copied) or transcoding
        const isRemuxing = decision?.videoAction === 'copy';

        // Whether audio is ALLOWED to be copied. Subtitle burn-in transcodes the
        // video, but that says nothing about audio — the overlay is a video filter.
        //
        // This matters for correctness, not just cost: the master playlist
        // advertises the SOURCE audio codec unless the client asked for AAC. Let
        // burn-in drag audio into a re-encode and the manifest still says `ec-3`
        // while the segments carry AAC, so AVFoundation rejects the stream with
        // 'fmt?' (CoreMediaErrorDomain 1718449215) at playback start. Verified on
        // prod: without burn-in advertised ec-3 / actual eac3; with burn-in
        // advertised ec-3 / actual aac.
        const audioCanBeCopied = isRemuxing || !!config.subtitleBurnIn;

        // In muxed mode, only one audio track was mapped — configure just that one
        const isMuxedAudio = config.hlsOutput?.hlsAudioMode === 'muxed';
        const tracksToEncode = isMuxedAudio
            ? (() => {
                  // Must resolve to the SAME track the mapping step selected above.
                  // hlsAudioTrackIndex is the absolute stream index; resolve it to
                  // the array position. The no-request fallback has to be the
                  // identical expression used there — the file's default track,
                  // via defaultAudioAbsoluteIndex — or this step would configure
                  // the encoder from a DIFFERENT track than the one being muxed.
                  const resolved = resolveAudioTrackByAbsoluteIndex(
                      audioTracks,
                      asAbsoluteStreamIndex(
                          config.hlsOutput?.hlsAudioTrackIndex ??
                              defaultAudioAbsoluteIndex(audioTracks),
                      ),
                  );
                  return resolved.track ? [{ track: resolved.track, outputIndex: 0 }] : [];
              })()
            : audioTracks.map((track, i) => ({ track, outputIndex: i }));

        // Track whether any audio is transcoded (for filter application)
        let anyAudioTranscoded = false;
        let copiedCount = 0;
        let transcodedCount = 0;

        for (const { track, outputIndex: i } of tracksToEncode) {
            // Can only copy audio when:
            // 1. Audio transcoding is not explicitly forced (e.g. browser AAC request)
            // 2. Video is being copied (remuxing scenario)
            // 3. Audio codec is HLS-compatible
            const canCopyAudio =
                !config.forceAudioTranscode &&
                audioCanBeCopied &&
                isHlsCompatibleAudioCodec(track.codec);

            if (canCopyAudio) {
                // Copy audio to preserve quality
                builder.copyAudio(i);
                copiedCount++;
                logger.debug('Copying audio track', {
                    index: i,
                    codec: track.codec,
                    bitrate: track.bitrate ? `${Math.round(track.bitrate / 1000)}kbps` : 'unknown',
                });
            } else {
                // Must transcode (either video is transcoded or audio codec not HLS-compatible)
                const sourceChannels = track.channels && track.channels > 0 ? track.channels : 2;
                let channels = Math.min(
                    sourceChannels,
                    maxAudioChannels,
                    config.maxAudioChannels ?? maxAudioChannels,
                );

                // Per-request quality cap: a tiny audio reservation can't fit
                // a surround mix at any reasonable bitrate — downmix to
                // stereo so the reservation buys quality instead of an
                // inaudibly-compressed 5.1 track.
                const qualityCapReservationBps = config.qualityCapAudioReservationBps;
                if (
                    qualityCapReservationBps !== undefined &&
                    channels > 2 &&
                    qualityCapReservationBps < AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS
                ) {
                    channels = 2;
                }

                // Calculate adaptive bitrate based on source quality
                const fallbackBitrate =
                    channels > 2 ? config.audioBitrateSurround : config.audioBitrateStereo;
                let bitrate = this.calculateAdaptiveAudioBitrate(
                    track.bitrate,
                    channels,
                    fallbackBitrate,
                );

                // Never let the transcoded track exceed its reserved share of
                // the quality cap's effective total budget (see
                // computeAudioReservationBps) — otherwise the video budget
                // computed from the SAME reservation would be short-changed
                // by whatever audio actually consumes.
                if (qualityCapReservationBps !== undefined) {
                    bitrate = capAudioBitrateString(bitrate, qualityCapReservationBps);
                }

                const codec = config.audioCodec || 'aac';

                builder.setAudioCodec(codec, i, {
                    bitrate,
                    channels,
                    vbr: config.audioVbr,
                });

                anyAudioTranscoded = true;
                transcodedCount++;
                this.transcodedAudioOutputs.push({ outputIndex: i, codec });
                logger.debug('Transcoding audio track', {
                    index: i,
                    sourceCodec: track.codec,
                    targetCodec: codec,
                    targetBitrate: bitrate,
                    reason: audioCanBeCopied
                        ? 'codec not HLS-compatible'
                        : 'video being transcoded',
                });
            }
        }

        logger.debug('Audio encoding configured', {
            remuxing: isRemuxing,
            copied: copiedCount,
            transcoded: transcodedCount,
        });

        // Store for filter logic
        this.anyAudioTranscoded = anyAudioTranscoded;
        this.anyAudioCopied = copiedCount > 0;
    }

    /**
     * Calculate transcode bitrate from source (following Jellyfin's approach).
     * Scales bitrate based on codec efficiency differences.
     *
     * @param sourceBitrateBps Source video bitrate in bits per second
     * @param sourceCodec Source codec name (h264, hevc, av1, etc.)
     * @param targetCodec Target codec name (h264, hevc, av1)
     * @param width Video width for fallback calculation
     * @returns Target bitrate in Mbps
     */
    private calculateTranscodeBitrate(
        sourceBitrateBps: number,
        sourceCodec: string,
        targetCodec: string,
        width: number,
    ): number {
        // Codec efficiency scale factors (relative to H.264)
        // HEVC/VP9 are ~40% more efficient, AV1 is ~50% more efficient
        const getScaleFactor = (codec: string): number => {
            const lc = codec.toLowerCase();
            if (
                lc.includes('hevc') ||
                lc.includes('h265') ||
                lc.includes('265') ||
                lc.includes('vp9')
            ) {
                return 0.6;
            }
            if (lc.includes('av1')) {
                return 0.5;
            }
            return 1.0; // H.264 baseline
        };

        // If we have source bitrate, scale it based on codec efficiency
        if (sourceBitrateBps > 0) {
            const inputScale = getScaleFactor(sourceCodec);
            const outputScale = getScaleFactor(targetCodec);

            // Scale factor: don't go below 1x (don't increase bitrate unless necessary)
            const scaleFactor = Math.max(outputScale / inputScale, 1.0);
            let bitrate = sourceBitrateBps * scaleFactor;

            // Jellyfin's low bitrate boost (improves quality for low bitrate sources)
            if (sourceBitrateBps <= 2_000_000) {
                bitrate = sourceBitrateBps * 2.5 * scaleFactor;
            } else if (sourceBitrateBps <= 3_000_000) {
                bitrate = sourceBitrateBps * 2 * scaleFactor;
            }

            // Convert to Mbps and cap at reasonable values
            const bitrateMbps = Math.min(bitrate / 1_000_000, 100); // Cap at 100 Mbps
            return Math.max(bitrateMbps, 1); // Minimum 1 Mbps
        }

        // Fallback: estimate based on resolution (when source bitrate unknown)
        // These are conservative defaults for streaming
        if (width >= 3840) return 25; // 4K
        if (width >= 2560) return 15; // 1440p
        if (width >= 1920) return 10; // 1080p
        if (width >= 1280) return 5; // 720p
        return 2; // SD
    }
}

/**
 * GOP mode applies only to the demux fMP4 copy-video output; anything else
 * (muxed, transcoded video, the audio-only rung) keeps the single output.
 */
function isVideoCopyGop(
    config: FullStrategyConfig,
    videoAction: { action: 'copy' | 'transcode' },
): { videoStartKeyframe: number } | null {
    if (!config.gopSegments || videoAction.action !== 'copy') return null;
    if ((config.hlsOutput?.hlsAudioMode ?? 'demux') !== 'demux') return null;
    if ((config.hlsOutput?.hlsContainer ?? 'fmp4') !== 'fmp4') return null;
    if (config.audioTracks.length === 0) return null;
    return config.gopSegments;
}
