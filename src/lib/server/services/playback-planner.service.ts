// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaybackPlannerService
 *
 * Single-authority planner that creates immutable PlaybackPlan objects.
 * Plans are stored in Valkey with a 30-minute TTL and retrieved by ID.
 */

import type { PlayMethod } from '$lib/schemas/play-sessions.js';
import { randomUUID } from 'crypto';
import type {
    PlanIntent,
    DeliveryPath,
    SubtitleMethod,
    PlaybackBranch,
    HlsAudioMode,
} from '$lib/schemas/playback-plan.js';
import { PlaybackPlanSchema, type PlaybackPlan } from '$lib/schemas/playback-plan.js';
import {
    checkCompatibility,
    selectTranscodeCodec,
    parseSoftwareCodecPreference,
    buildTranscodeReasons,
    buildTranscodeReasonCodes,
    type MediaInfo,
    type DeviceCapabilities,
    type ServerEncodeCaps,
    type CompatibilityResult,
    type PlayRecommendation,
    type TranscodeReason,
} from '$lib/server/utils/media-compatibility.js';
import { hardwareDetection } from '$lib/server/services/transcoding/hardware-detection.js';
import { setEx, getCoordinationClient, expire } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';

const logger = Logger.for('PlaybackPlanner');

const PLAN_TTL_SECONDS = 30 * 60; // 30 minutes
const PLAN_KEY_PREFIX = 'v1:playback-plan:';

export interface CreatePlanParams {
    intent: PlanIntent;
    fileId: string;
    mediaInfo: MediaInfo;
    caps: DeviceCapabilities;
    serverEncode: ServerEncodeCaps;
    deliveryPath: DeliveryPath;
    subtitleMethod?: SubtitleMethod;
    requestedMethod?: PlayRecommendation;
    enableHdrPreservation?: boolean;
    /**
     * Which kind of player will consume this plan. Only affects the native_hls
     * audio mode: browser-native HLS uses muxed audio for copied video; native
     * clients opt in through supportsHlsCopyReload. See resolveHlsAudioMode().
     *
     * Defaults to 'browser' — the conservative choice, since that keeps the
     * muxed fallback for any caller that has not been taught to pass this.
     */
    clientType?: 'browser' | 'native';
    /**
     * Store the plan in Valkey so a later request can reference it by `plan_id`.
     * Defaults to true. A read-only probe (POST /media/{id}/playability) passes
     * false: it keeps the decision but leaves nothing behind, and the plan has no
     * `plan_id` because no request can ever look it up.
     */
    persist?: boolean;
}

export interface CreatePlanResult {
    plan: PlaybackPlan;
    compatibility: CompatibilityResult;
}

class PlaybackPlannerService {
    /**
     * Create a new PlaybackPlan based on media info and client capabilities.
     * Stores the plan in Valkey and returns it.
     */
    async createPlan(params: CreatePlanParams): Promise<CreatePlanResult> {
        const {
            intent,
            fileId,
            mediaInfo,
            caps,
            serverEncode,
            subtitleMethod = 'none',
            requestedMethod,
            enableHdrPreservation = false,
            clientType = 'browser',
            persist = true,
        } = params;
        let deliveryPath = params.deliveryPath;

        // Run canonical compatibility check
        const compat = checkCompatibility(mediaInfo, caps);
        let recommended = compat.recommended;
        let transcodeReasons = buildTranscodeReasons(mediaInfo, compat, caps);
        let transcodeReasonCodes: TranscodeReason[] = buildTranscodeReasonCodes(
            mediaInfo,
            compat,
            caps,
        );

        // A non-file transport requires remuxing even when all codecs are native.
        // Keep the recommendation consistent with direct availability.
        if (recommended === 'direct' && deliveryPath !== 'direct_file') {
            recommended = 'remux';
            const multiAudio = mediaInfo.audioTrackCount > 1;
            transcodeReasons.push(
                multiAudio ? 'Multiple audio tracks require HLS' : 'Container requires HLS',
            );
            transcodeReasonCodes.push({
                code: multiAudio ? 'multi_audio_needs_hls' : 'container_incompatible',
            });
        }

        if (subtitleMethod === 'burn_in') {
            recommended = 'full_transcode';
            transcodeReasons.push('Selected subtitles require burn-in');
            transcodeReasonCodes.push({ code: 'subtitle_burn_in' });
        }

        const methodRank: Record<PlayRecommendation, number> = {
            direct: 0,
            remux: 1,
            audio_transcode: 2,
            full_transcode: 3,
            audio_only: 3,
        };
        if (
            requestedMethod &&
            requestedMethod !== recommended &&
            methodRank[requestedMethod] >= methodRank[recommended]
        ) {
            recommended = requestedMethod;
            transcodeReasons.push('Client requested additional conversion');
            transcodeReasonCodes.push({ code: 'client_requested' });
        }

        // Preview constraints: force full_transcode, h264, no HDR
        if (intent === 'preview') {
            recommended = 'full_transcode';
            transcodeReasons = ['Preview mode: forced transcode to H.264'];
            transcodeReasonCodes = [{ code: 'preview_mode' }];
        }

        if (recommended !== 'direct' && deliveryPath === 'direct_file')
            deliveryPath = clientType === 'native' ? 'native_hls' : 'mse_hls';

        // Method and transport agree; requested upgrades have already been applied.
        // The actions below feed both the published decision and the stored executor plan.
        const videoAction = this.resolveVideoAction(recommended, intent);
        const audioAction = this.resolveAudioAction(recommended, intent);
        const playbackBranch = this.resolvePlaybackBranch(deliveryPath, recommended);
        const hlsAudioMode =
            recommended === 'audio_only'
                ? 'muxed'
                : this.resolveHlsAudioMode(
                      deliveryPath,
                      playbackBranch,
                      videoAction,
                      clientType,
                      caps.supportsHlsCopyReload === true,
                      caps.prefersHlsDemuxAudio === true,
                  );

        // Select transcode codec
        let targetVideoCodec: string | undefined;
        let targetAudioCodec: string | undefined;

        if (videoAction === 'transcode') {
            if (intent === 'preview') {
                targetVideoCodec = 'h264';
            } else {
                if (!mediaInfo.width) {
                    logger.warn(
                        'mediaInfo.width missing — defaulting to software 4K clamp for safety',
                        { fileId },
                    );
                }
                const codec = selectTranscodeCodec(caps, serverEncode, {
                    deliveryPath,
                    sourceWidth: mediaInfo.width ?? 0,
                    allowAv1OnMseHls: config.ALLOW_AV1_MSE_HLS,
                    allowHevcEncoding: config.ALLOW_HEVC_ENCODING,
                    allowAv1Encoding: config.ALLOW_AV1_ENCODING,
                    softwareCodecPreference: parseSoftwareCodecPreference(
                        config.SOFTWARE_CODEC_PREFERENCE,
                    ),
                    softwareMaxWidth: config.SOFTWARE_ENCODE_MAX_WIDTH,
                });
                targetVideoCodec = codec ?? 'h264';
            }
            if (!serverEncode.canEncodeCodec(targetVideoCodec)) {
                logger.warn('Target video codec not encodable by server, falling back to h264', {
                    targetVideoCodec,
                    fileId,
                });
                targetVideoCodec = 'h264';
            }
        }

        if (audioAction === 'transcode') {
            targetAudioCodec = 'aac';
        }

        // Resolve GPU encoder/decoder
        let gpuEncoder: string | undefined;
        let gpuDecoder: string | undefined;
        if (targetVideoCodec) {
            const encoderCodec = targetVideoCodec as 'h264' | 'hevc' | 'av1';
            gpuEncoder = (await hardwareDetection.getBestEncoder(encoderCodec)) ?? undefined;
            gpuDecoder =
                (await hardwareDetection.getBestDecoder(mediaInfo.videoCodec)) ?? undefined;
        }

        // HDR handling — resolve what HDR type reaches the player
        const sourceHdrType = mediaInfo.hdr ?? 'sdr';

        // HDR can only survive a full (re-encode) transcode into a 10-bit-capable
        // codec. h264 cannot carry HDR10/HLG/DV — feeding 10-bit HDR frames to an
        // 8-bit h264 encoder fails ("Could not open encoder", VA-API -38). So an
        // HDR->h264 transcode MUST tonemap to SDR even when the device itself can
        // display HDR. (A copy keeps the source codec, which is HDR-capable by
        // definition, so this only constrains full transcodes.)
        const targetCodecHdrCapable = targetVideoCodec === 'hevc' || targetVideoCodec === 'av1';

        // A COPY preserves Dolby Vision — ffmpeg writes the `dvvC` box into the fMP4
        // init segment — so output_hdr stays the source's DV type on the remux path.
        //
        // A full transcode is different: re-encoding drops the DV RPU. When the source
        // is cross-compatible DV ('dovi_hdr10') the base layer is HDR10, so the honest
        // and best target is HDR10. Tone-mapping it all the way to SDR — which is what
        // we used to do for clients that don't advertise DV — threw away HDR for no
        // reason. Profiles 5/7 ('dovi') have no base layer and do need a real tone-map.
        const dvTranscodesToHdr10 =
            sourceHdrType === 'dovi_hdr10' && recommended === 'full_transcode';
        const effectiveSourceHdr = dvTranscodesToHdr10 ? 'hdr10' : sourceHdrType;

        // For cross-compatible DV the compat layer's needsTonemapping is a codec-string
        // sanitization (see media-compatibility.ts), not an HDR->SDR conversion — the
        // HDR10 base layer survives the re-encode, so it must not force SDR output.
        const needsRealTonemap = compat.needsTonemapping && !dvTranscodesToHdr10;

        // Can the output stay HDR? Only when: not a preview, server has HDR
        // preservation enabled, the device doesn't need tonemapping, the source is
        // HDR, AND (we're copying OR re-encoding into an HDR-capable codec).
        const canPreserveHdr =
            intent !== 'preview' &&
            enableHdrPreservation &&
            !needsRealTonemap &&
            effectiveSourceHdr !== 'sdr' &&
            (recommended !== 'full_transcode' || targetCodecHdrCapable);

        // Resolve output_hdr + whether we must tonemap. When the source is HDR but
        // the output won't be HDR (device wants SDR, or we're re-encoding into a
        // codec that can't carry HDR like h264), the HDR->SDR conversion REQUIRES
        // tonemapping — otherwise 10-bit HDR frames hit an SDR/8-bit encoder.
        let needsTonemapping = needsRealTonemap;
        let outputHdr: string | undefined;
        if (effectiveSourceHdr === 'sdr') {
            outputHdr = 'sdr';
        } else if (recommended !== 'full_transcode') {
            // Video copied. HDR survives by nature — but DV does not (see above), so
            // this reports the base layer, not the source's DV type.
            outputHdr = effectiveSourceHdr;
        } else if (canPreserveHdr) {
            outputHdr = effectiveSourceHdr;
        } else {
            outputHdr = 'sdr';
            needsTonemapping = true;
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + PLAN_TTL_SECONDS * 1000);

        const plan: PlaybackPlan = {
            plan_id: randomUUID(),
            intent,
            delivery_path: deliveryPath,
            playback_branch: playbackBranch,
            method: recommended,
            video_action: videoAction,
            audio_action: audioAction,
            hls_audio_mode: hlsAudioMode,
            target_video_codec: targetVideoCodec,
            target_audio_codec: targetAudioCodec,
            subtitle_method: subtitleMethod,
            transcode_reasons: transcodeReasons,
            transcode_reason_codes: transcodeReasonCodes,
            output_hdr: outputHdr,
            needs_tonemapping: needsTonemapping,
            source_video_codec: mediaInfo.videoCodec || undefined,
            source_audio_codec: mediaInfo.audioCodecs[0] || undefined,
            gpu_encoder: gpuEncoder,
            gpu_decoder: gpuDecoder,
            // The client's HDR display capability, so a job that has to re-encode
            // this plan's copy (quality-cap safety net) can tone-map or preserve
            // HDR the way a planned transcode would for this client.
            ...(caps.hdrFormats ? { client_hdr_formats: [...caps.hdrFormats] } : {}),
            // Record the cap this plan was checked against: the HLS job then
            // trusts the plan's copy/transcode call for that cap instead of
            // re-evaluating it with different data (see
            // qualityCapForcesTranscode — the planner is authoritative).
            ...(caps.userSelectedMaxBitrate !== undefined ||
            caps.userSelectedMaxHeight !== undefined
                ? {
                      quality_cap: {
                          ...(caps.userSelectedMaxBitrate !== undefined
                              ? { max_bitrate: caps.userSelectedMaxBitrate }
                              : {}),
                          ...(caps.userSelectedMaxHeight !== undefined
                              ? { max_height: caps.userSelectedMaxHeight }
                              : {}),
                      },
                  }
                : {}),
            file_id: fileId,
            created_at: now.toISOString(),
            expires_at: expiresAt.toISOString(),
        };

        // Store in Valkey — if storage fails, clear plan_id so the client
        // won't reference a plan that can't be retrieved later
        const stored = persist ? await this.storePlan(plan) : false;
        if (!stored) {
            plan.plan_id = undefined;
        }

        // A read-only probe plans every version on every call; keep it out of the info log.
        const log = persist ? logger.info.bind(logger) : logger.debug.bind(logger);
        log('Playback plan created', {
            planId: plan.plan_id,
            fileId,
            method: plan.method,
            deliveryPath: plan.delivery_path,
            playbackBranch: plan.playback_branch,
            hlsAudioMode: plan.hls_audio_mode,
            videoAction: plan.video_action,
            audioAction: plan.audio_action,
            transcodeReasons: plan.transcode_reasons,
        });

        return { plan, compatibility: compat };
    }

    /**
     * Retrieve a plan from Valkey by ID. Returns null if expired or not found.
     */
    async getPlan(planId: string): Promise<PlaybackPlan | null> {
        const client = getCoordinationClient();
        if (!client) {
            logger.warn('Valkey unavailable, cannot retrieve plan', { planId });
            return null;
        }

        try {
            const key = `${PLAN_KEY_PREFIX}${planId}`;
            const raw = await client.get(key);
            if (!raw) return null;
            const str =
                typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8');
            const parsed: unknown = JSON.parse(str);
            const result = PlaybackPlanSchema.safeParse(parsed);
            if (!result.success) {
                logger.warn('Plan failed schema validation, discarding', {
                    planId,
                    errors: result.error.issues.map((i) => i.message),
                });
                return null;
            }
            return result.data;
        } catch (error) {
            logger.error('Failed to retrieve plan', error instanceof Error ? error : undefined, {
                planId,
            });
            return null;
        }
    }

    /**
     * Refresh the TTL on a plan (e.g. on HLS segment requests during long playback).
     */
    async refreshPlan(planId: string): Promise<boolean> {
        const key = `${PLAN_KEY_PREFIX}${planId}`;
        return expire(key, PLAN_TTL_SECONDS);
    }

    /**
     * Update the subtitle_method on an existing plan in Valkey.
     * Used when burn-in is activated during playback (late-binding subtitle selection).
     */
    async updateSubtitleMethod(planId: string, subtitleMethod: SubtitleMethod): Promise<void> {
        const plan = await this.getPlan(planId);
        if (!plan) return;
        plan.subtitle_method = subtitleMethod;
        await this.storePlan(plan);
    }

    async upgradePlan(
        planId: string,
        method: PlayMethod,
        burnIn: boolean,
    ): Promise<PlaybackPlan['hls_audio_mode']> {
        const plan = await this.getPlan(planId);
        if (!plan) return undefined;
        plan.method = method;
        if (plan.delivery_path === 'direct_file') plan.delivery_path = 'native_hls';
        plan.playback_branch = this.resolvePlaybackBranch(plan.delivery_path, method);
        plan.hls_audio_mode = plan.delivery_path === 'native_hls' ? 'demux' : 'muxed';
        if (method === 'full_transcode' || method === 'audio_only') {
            plan.video_action = 'transcode';
            plan.target_video_codec ??= 'h264';
            plan.playback_branch = 'full_transcode';
            if (plan.output_hdr !== 'sdr' && plan.target_video_codec === 'h264') {
                plan.output_hdr = 'sdr';
                plan.needs_tonemapping = true;
            }
        }
        if (
            method === 'audio_transcode' ||
            method === 'full_transcode' ||
            method === 'audio_only'
        ) {
            plan.audio_action = 'transcode';
            plan.target_audio_codec ??= 'aac';
        }
        if (burnIn) plan.subtitle_method = 'burn_in';
        await this.storePlan(plan);
        // What the HLS executor will now deliver; the start response must report this.
        return plan.hls_audio_mode;
    }

    // ── Private helpers ──

    private resolveVideoAction(
        recommended: PlayRecommendation,
        intent: PlanIntent,
    ): 'copy' | 'transcode' {
        if (intent === 'preview') return 'transcode';
        return recommended === 'full_transcode' ? 'transcode' : 'copy';
    }

    private resolveAudioAction(
        recommended: PlayRecommendation,
        intent: PlanIntent,
    ): 'copy' | 'transcode' {
        if (intent === 'preview') return 'transcode';
        if (
            recommended === 'audio_transcode' ||
            recommended === 'full_transcode' ||
            recommended === 'audio_only'
        )
            return 'transcode';
        return 'copy';
    }

    private resolvePlaybackBranch(
        deliveryPath: DeliveryPath,
        method: PlayRecommendation,
    ): PlaybackBranch {
        if (deliveryPath === 'direct_file' && method === 'direct') return 'direct';
        if (method === 'full_transcode') return 'full_transcode';
        if (deliveryPath === 'native_hls') return 'native_hls_multi_audio';
        if (deliveryPath === 'mse_hls') return 'web_hls_single_audio';
        return 'remux_api';
    }

    private resolveHlsAudioMode(
        deliveryPath: DeliveryPath,
        playbackBranch: PlaybackBranch,
        videoAction: 'copy' | 'transcode',
        clientType: 'browser' | 'native',
        supportsHlsCopyReload: boolean,
        prefersHlsDemuxAudio = false,
    ): HlsAudioMode | undefined {
        if (deliveryPath === 'native_hls') {
            // Full transcode gives FFmpeg uniform keyframes → stable EXTINF, so
            // demux multi-audio is always safe there.
            if (videoAction === 'transcode') return 'demux';

            // iPhone/iPad Safari: muxed fMP4 with AC-3 audio looped on its first
            // segment — AVFoundation added and dropped the audio track every
            // ~100 ms and cancelled the segment each time (device log
            // 2026-10-15). Muxed also gets no master playlist on iOS, so no
            // CODECS. Demux gives a master with CODECS and audio as its own
            // rendition (Apple HLS authoring spec 9.6: multichannel audio MUST
            // be separate). Copy video in demux mode also gets the GOP keyframe
            // grid when eligible (HLS_COPY_GOP_SEGMENTS), so the declared segment
            // times match the file.
            if (prefersHlsDemuxAudio) return 'demux';

            // Copy-mode video has irregular keyframe spacing, which makes Safari's
            // EXTINF-accumulated currentTime drift from actual PTS after a seek and
            // desyncs subtitles. Muxed (single selected audio) avoids that.
            //
            // AVPlayer also exposes the demux playlist's mixed real/synthetic
            // timeline: a 1330.944 s episode advertised 1332.951 s after 113
            // segments had been produced. Updated native clients opt in to the
            // complete muxed keyframe grid and reload on unbuffered seeks/audio
            // changes. Older clients still need the demux audio group for their
            // language picker, so deploying the server alone must not switch them.
            return clientType === 'native' && !supportsHlsCopyReload ? 'demux' : 'muxed';
        }
        if (
            deliveryPath === 'mse_hls' ||
            playbackBranch === 'web_hls_single_audio' ||
            playbackBranch === 'full_transcode'
        ) {
            return 'muxed';
        }
        return undefined;
    }

    private async storePlan(plan: PlaybackPlan): Promise<boolean> {
        if (!plan.plan_id) {
            logger.warn('storePlan called with no plan_id, skipping');
            return false;
        }
        const key = `${PLAN_KEY_PREFIX}${plan.plan_id}`;
        const stored = await setEx(key, PLAN_TTL_SECONDS, JSON.stringify(plan));
        if (!stored) {
            logger.warn(
                'Failed to store plan in Valkey (service unavailable), plan will only exist in-memory response',
                {
                    planId: plan.plan_id,
                },
            );
            return false;
        }
        return true;
    }
}

export const playbackPlanner = new PlaybackPlannerService();
export { PlaybackPlannerService };
