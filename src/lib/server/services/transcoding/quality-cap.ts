// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-request quality cap for VOD HLS.
 *
 * The VOD master playlist has exactly one variant — there is no ABR ladder to
 * fall back to on a slow link. Instead a client passes `maxBitrate` (bits/s,
 * total stream budget) and/or `maxHeight` (px) on the master playlist URL, and
 * the server transcodes down to it when the source exceeds it. This module is
 * the single source of truth for parsing/clamping those params and for
 * deriving the capped encode geometry AND the effective total bitrate budget,
 * so the transcode decision, the FFmpeg args, and the manifest
 * BANDWIDTH/RESOLUTION all agree on the same numbers.
 */

import type { AudioTrackInfo } from '../../utils/hls-audio-injection.js';
import {
    asAbsoluteStreamIndex,
    defaultAudioAbsoluteIndex,
    resolveAudioTrackByAbsoluteIndex,
} from '$lib/shared/stream-index';

/** Total stream budget in bits/second. */
export const MIN_MAX_BITRATE_BPS = 250_000;
export const MAX_MAX_BITRATE_BPS = 200_000_000;

/** Output height in pixels. */
export const MIN_MAX_HEIGHT_PX = 144;
export const MAX_MAX_HEIGHT_PX = 4320;

/** Floor so a pathological budget never asks FFmpeg for a ~0 video bitrate. */
const MIN_VIDEO_BUDGET_BPS = 100_000;

/**
 * Audio's share of the effective total budget: `round(budget * FRACTION)`,
 * clamped to [MIN_AUDIO_RESERVATION_BPS, MAX_AUDIO_RESERVATION_BPS]. Adaptive
 * AAC surround can run up to ~512 kbps and copied AC-3/E-AC-3 audio can be
 * 640 kbps / ~1.5 Mbps — a flat reservation (e.g. the old fixed
 * AUDIO_BITRATE_SURROUND) either starves the video on a big source or lets
 * audio alone blow a small cap.
 */
export const AUDIO_RESERVATION_FRACTION = 0.2;
export const MIN_AUDIO_RESERVATION_BPS = 128_000;
export const MAX_AUDIO_RESERVATION_BPS = 512_000;

/** Below this audio reservation, a >2-channel transcode is downmixed to stereo. */
export const AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS = 192_000;

/**
 * Implied total bitrate budget for a given output height, used when a
 * `maxHeight` cap forces a downscale but the client sent no `maxBitrate` —
 * a QSV/CRF encoder otherwise derives its bitrate from the SOURCE bitrate
 * regardless of the (much smaller) output resolution, so a 120 Mbit 4K
 * source capped to 720p would still encode at ~100 Mbit.
 */
const IMPLIED_BUDGET_THRESHOLDS: ReadonlyArray<readonly [maxHeight: number, budgetBps: number]> = [
    [480, 1_500_000],
    [720, 4_000_000],
    [1080, 10_000_000],
    [1440, 20_000_000],
];
const IMPLIED_BUDGET_DEFAULT_BPS = 40_000_000;

export interface QualityCap {
    /** Total stream budget in bits/second, clamped to [MIN_MAX_BITRATE_BPS, MAX_MAX_BITRATE_BPS]. */
    maxBitrate?: number;
    /** Output height in pixels, clamped to [MIN_MAX_HEIGHT_PX, MAX_MAX_HEIGHT_PX]. */
    maxHeight?: number;
}

/**
 * Parse a positive finite integer from a query param, or undefined if
 * missing/invalid. Never throws — an invalid value is silently ignored,
 * matching the existing `?maxBitrate` handling in the internal info def.
 */
function parsePositiveInt(raw: string | null): number | undefined {
    if (raw === null || raw === '') return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return undefined;
    return parsed;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * The LAST occurrence of a query param, or null when absent. /info bakes the
 * requested cap into its play_methods URLs, and a client may append its own on
 * top: the same value twice is harmless, and a different value is the client's
 * explicit override — so the last one wins (`URLSearchParams.get` would return
 * the first, silently ignoring the override).
 */
function lastParam(searchParams: URLSearchParams, name: string): string | null {
    const all = searchParams.getAll(name);
    return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * Parse and clamp `maxBitrate` (bits/s) and `maxHeight` (px) from a request's
 * search params. Invalid values (non-numeric, non-positive, non-integer) are
 * silently ignored rather than rejected — consistent with how `?maxBitrate`
 * is already handled by the internal playback info def. A repeated param
 * resolves to its last occurrence (see {@link lastParam}).
 */
export function parseQualityCapParams(searchParams: URLSearchParams): QualityCap {
    const rawBitrate = parsePositiveInt(lastParam(searchParams, 'maxBitrate'));
    const rawHeight = parsePositiveInt(lastParam(searchParams, 'maxHeight'));

    const cap: QualityCap = {};
    if (rawBitrate !== undefined) {
        cap.maxBitrate = clamp(rawBitrate, MIN_MAX_BITRATE_BPS, MAX_MAX_BITRATE_BPS);
    }
    if (rawHeight !== undefined) {
        cap.maxHeight = clamp(rawHeight, MIN_MAX_HEIGHT_PX, MAX_MAX_HEIGHT_PX);
    }
    return cap;
}

/** Upper bound for `maxAudioChannels` (7.1). */
export const MAX_MAX_AUDIO_CHANNELS = 8;

/**
 * Parse the client's audio channel cap (`?maxAudioChannels`, the `mc:` it
 * declared to /info). Kept OUT of {@link QualityCap} on purpose: everything
 * that sees a QualityCap treats it as a VIDEO cap (budget, geometry, the
 * copy→transcode safety net), and a channel cap must trigger none of that.
 * Invalid values are silently ignored; repeated params resolve to the last.
 */
export function parseMaxAudioChannelsParam(searchParams: URLSearchParams): number | undefined {
    const raw = parsePositiveInt(lastParam(searchParams, 'maxAudioChannels'));
    return raw === undefined ? undefined : Math.min(raw, MAX_MAX_AUDIO_CHANNELS);
}

/** True when the cap carries no constraint at all. */
export function isEmptyQualityCap(cap: QualityCap | undefined): boolean {
    return !cap || (cap.maxBitrate === undefined && cap.maxHeight === undefined);
}

/**
 * The server-clamped effective height bound for `cap.maxHeight` — we only
 * ever shrink the requested cap with the admin MAX_HEIGHT setting (0/unset
 * means no server bound), never grow it. Undefined when no height cap is set.
 */
export function effectiveCapHeight(
    cap: QualityCap | undefined,
    serverMaxHeight: number | undefined,
): number | undefined {
    if (!cap?.maxHeight) return undefined;
    return serverMaxHeight && serverMaxHeight > 0
        ? Math.min(cap.maxHeight, serverMaxHeight)
        : cap.maxHeight;
}

/**
 * Whether the (server-clamped) height cap is actually binding for this
 * source — true both when the source is known to exceed it AND when the
 * source's height is simply unknown (an unprobed file must not be remuxed
 * uncapped just because we can't measure it; see `sourceExceedsQualityCap`).
 */
function isHeightCapBinding(
    cap: QualityCap | undefined,
    sourceHeight: number | undefined,
    serverMaxHeight: number | undefined,
): boolean {
    const capHeight = effectiveCapHeight(cap, serverMaxHeight);
    if (capHeight === undefined) return false;
    return !sourceHeight || sourceHeight > capHeight;
}

/**
 * Whether the source exceeds either bound of the cap — i.e. whether a
 * copy/remux must be upgraded to a forced transcode. A cap that is unset, or
 * that the source already satisfies, changes nothing (per spec: "if the
 * source is already within the caps, change nothing").
 *
 * An UNKNOWN source dimension/bitrate (0/undefined — an unprobed file) counts
 * as EXCEEDING whenever that cap bound is set: the alternative is remuxing an
 * unmeasured file uncapped to a client that explicitly asked for a ceiling.
 */
export function sourceExceedsQualityCap(
    cap: QualityCap | undefined,
    sourceHeight: number | undefined,
    sourceBitrate: number | undefined,
): boolean {
    if (isEmptyQualityCap(cap)) return false;
    const heightExceeds =
        cap!.maxHeight !== undefined && (!sourceHeight || sourceHeight > cap!.maxHeight);
    const bitrateExceeds =
        cap!.maxBitrate !== undefined && (!sourceBitrate || sourceBitrate > cap!.maxBitrate);
    return heightExceeds || bitrateExceeds;
}

/**
 * The source bitrate a quality cap is compared against — ONE definition for
 * the planner (info.service → media-compatibility) and the HLS job
 * (playback.service → mediaSourceInfo.bitrate → the cap safety net).
 *
 * The container's overall bitrate first, the video stream's as fallback — the
 * same formula the scanner persists as `media_files.total_bitrate`. The two
 * sides used to read different numbers: the planner the format bitrate
 * (4.6 Mbps for the Windows e2e file), the job the per-stream video bitrate,
 * which MKV usually lacks. The job then saw "unknown", treated that as
 * exceeding a 10 Mbps cap, and flipped a copy plan the planner had cleared.
 */
export function capComparableBitrate(source: {
    formatBitrate?: number | null;
    videoBitrate?: number | null;
}): number | undefined {
    const pick = source.formatBitrate || source.videoBitrate;
    return pick && pick > 0 ? pick : undefined;
}

/** The cap a playback plan was evaluated against (`PlaybackPlan.quality_cap`). */
export interface PlanQualityCap {
    max_bitrate?: number;
    max_height?: number;
}

/**
 * Whether the planner already evaluated this job's cap: every bound the job
 * carries is matched by a bound in the plan that is at least as tight. A plan
 * that saw the same (or a stricter) cap made the copy/transcode call itself —
 * the planner is authoritative for the quality cap.
 */
export function planEvaluatedQualityCap(
    planCap: PlanQualityCap | null | undefined,
    cap: QualityCap | undefined,
): boolean {
    if (!planCap || isEmptyQualityCap(cap)) return false;
    if (cap!.maxBitrate !== undefined) {
        if (planCap.max_bitrate === undefined || planCap.max_bitrate > cap!.maxBitrate) {
            return false;
        }
    }
    if (cap!.maxHeight !== undefined) {
        if (planCap.max_height === undefined || planCap.max_height > cap!.maxHeight) {
            return false;
        }
    }
    return true;
}

export type QualityCapTranscodeVerdict =
    | { force: false; reason: 'no_cap' | 'plan_evaluated' | 'within_cap' }
    | { force: true; reason: 'safety_net' };

/**
 * Whether a per-request quality cap forces a copy/remux job to transcode.
 *
 * - The planner is authoritative: a plan built against the same cap already
 *   decided copy vs transcode (`plan_evaluated` → never flip).
 * - Otherwise (a plan created without cap information, or no plan at all —
 *   the /j/ path) this is a SAFETY NET, and it only fires on a bound the
 *   source is KNOWN to exceed. An unknown height/bitrate is treated the way
 *   the planner treats it (media-compatibility only flags known values):
 *   trust the plan, no flip.
 *
 * Deliberately not {@link sourceExceedsQualityCap}, whose unknown-counts-as-
 * exceeding rule sizes the capped encode geometry once a transcode is already
 * happening; it must not be what decides whether to transcode at all.
 */
export function qualityCapForcesTranscode(
    cap: QualityCap | undefined,
    sourceHeight: number | undefined,
    sourceBitrate: number | undefined,
    planCap?: PlanQualityCap | null,
): QualityCapTranscodeVerdict {
    if (isEmptyQualityCap(cap)) return { force: false, reason: 'no_cap' };
    if (planEvaluatedQualityCap(planCap, cap)) return { force: false, reason: 'plan_evaluated' };
    const heightExceeds =
        cap!.maxHeight !== undefined && !!sourceHeight && sourceHeight > cap!.maxHeight;
    const bitrateExceeds =
        cap!.maxBitrate !== undefined && !!sourceBitrate && sourceBitrate > cap!.maxBitrate;
    return heightExceeds || bitrateExceeds
        ? { force: true, reason: 'safety_net' }
        : { force: false, reason: 'within_cap' };
}

/**
 * Parse an FFmpeg-style bitrate string ("256k", "1M", "128000") to bits/second.
 * Returns 0 for anything unparseable so a caller's subtraction degrades to
 * "no audio budget reserved" instead of throwing.
 */
export function parseBitrateString(value: string | undefined): number {
    if (!value) return 0;
    const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value.trim());
    if (!match) {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : 0;
    }
    const num = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === 'k') return num * 1_000;
    if (unit === 'm') return num * 1_000_000;
    return num;
}

/** Implied total bitrate budget (bits/s) for a given output height. */
export function computeImpliedBitrateBudgetBps(height: number): number {
    for (const [maxHeight, budgetBps] of IMPLIED_BUDGET_THRESHOLDS) {
        if (height <= maxHeight) return budgetBps;
    }
    return IMPLIED_BUDGET_DEFAULT_BPS;
}

/**
 * The effective TOTAL stream budget (bits/s) for this cap against this
 * source — the single number both the encode and the manifest derive
 * video-bitrate and audio-reservation from.
 *
 * - `maxBitrate` alone → that value.
 * - `maxHeight` alone, and it actually downscales this source (or the
 *   source's height is unknown) → the height's implied budget.
 * - Both, and the height cap is binding → the SMALLER of the two (a resolution
 *   cap intended for 720p should not let a generous maxBitrate leave a 720p
 *   output encoding at 40 Mbps).
 * - Neither, or the height cap is set but does not actually bind this source
 *   → undefined (no budget applies — "change nothing").
 */
export function computeEffectiveBudgetBps(
    cap: QualityCap | undefined,
    sourceHeight: number | undefined,
    serverMaxHeight: number | undefined,
): number | undefined {
    const maxBitrate = cap?.maxBitrate;
    const downscaling = isHeightCapBinding(cap, sourceHeight, serverMaxHeight);
    const capHeight = downscaling ? effectiveCapHeight(cap, serverMaxHeight) : undefined;
    const implied = capHeight !== undefined ? computeImpliedBitrateBudgetBps(capHeight) : undefined;

    if (maxBitrate === undefined && implied === undefined) return undefined;
    if (maxBitrate === undefined) return implied;
    if (implied === undefined) return maxBitrate;
    return Math.min(maxBitrate, implied);
}

/**
 * Audio's reserved share (bits/s) of the effective total budget — see
 * {@link AUDIO_RESERVATION_FRACTION}. Undefined when there is no budget
 * (caller should leave audio bitrate/channel selection untouched).
 */
export function computeAudioReservationBps(
    effectiveBudgetBps: number | undefined,
): number | undefined {
    if (effectiveBudgetBps === undefined) return undefined;
    return clamp(
        Math.round(effectiveBudgetBps * AUDIO_RESERVATION_FRACTION),
        MIN_AUDIO_RESERVATION_BPS,
        MAX_AUDIO_RESERVATION_BPS,
    );
}

/**
 * The video bitrate (Mbps) to apply as a VBV cap (-b:v/-maxrate/-bufsize):
 * the effective total budget minus the audio reservation, floored at
 * {@link MIN_VIDEO_BUDGET_BPS}, never above the server's own
 * `VIDEO_BITRATE_MBPS` when that is configured and lower.
 *
 * Returns undefined when there is no effective budget — callers should leave
 * the encoder's existing bitrate/CRF logic untouched in that case.
 */
export function computeCappedVideoBitrateMbps(
    effectiveBudgetBps: number | undefined,
    audioReservationBps: number | undefined,
    serverVideoBitrateMbps: number,
): number | undefined {
    if (effectiveBudgetBps === undefined) return undefined;
    const reservation = audioReservationBps ?? 0;
    const videoBudgetBps = Math.max(effectiveBudgetBps - reservation, MIN_VIDEO_BUDGET_BPS);
    let mbps = videoBudgetBps / 1_000_000;
    if (serverVideoBitrateMbps > 0) {
        mbps = Math.min(mbps, serverVideoBitrateMbps);
    }
    return mbps;
}

/**
 * Aspect-preserving output dimensions for `cap.maxHeight`, with even width
 * and height (required by H.264/H.265 encoders).
 *
 * Returns undefined when no height cap applies, when the source is already
 * within it (nothing to override), or when source dimensions are unknown —
 * in the last case there is no explicit `-vf scale` to emit (the caller falls
 * back to its own generic resolution limit), but the budget-based VBV cap
 * from {@link computeEffectiveBudgetBps} still applies since THAT treats an
 * unknown height as binding.
 */
export function computeCappedDimensions(
    sourceWidth: number | undefined,
    sourceHeight: number | undefined,
    cap: QualityCap | undefined,
    serverMaxHeight: number | undefined,
): { width: number; height: number } | undefined {
    const capHeight = effectiveCapHeight(cap, serverMaxHeight);
    if (capHeight === undefined) return undefined;
    if (!sourceWidth || !sourceHeight || sourceHeight <= 0) return undefined;
    if (sourceHeight <= capHeight) return undefined;

    const targetHeight = Math.max(2, capHeight - (capHeight % 2));
    const targetWidth = Math.max(
        2,
        Math.round((sourceWidth * targetHeight) / sourceHeight / 2) * 2,
    );
    return { width: targetWidth, height: targetHeight };
}

/**
 * The audio track(s) a job actually DELIVERS: in muxed mode, exactly the one
 * track resolved for muxing (the same resolution `full-transcode-strategy.ts`
 * and the manifest's muxed-CODECS derivation use — search either for "mirror
 * the strategy's expression exactly"); in demux mode, every track (each gets
 * its own rendition, so every one of them matters for a budget check).
 *
 * Used both by the pre-job "should copied audio force a transcode" check and
 * by {@link computeQualityCapReservation}'s "largest delivered copied track"
 * bump, so a muxed job's OTHER (unselected) tracks — which the job never
 * actually sends — can't trigger either one.
 */
export function resolveDeliveredAudioTracks(
    audioTracks: readonly AudioTrackInfo[],
    hlsAudioMode: string | undefined,
    hlsAudioTrackIndex: number | undefined,
): AudioTrackInfo[] {
    if (hlsAudioMode !== 'muxed') return [...audioTracks];
    const resolved = resolveAudioTrackByAbsoluteIndex(
        audioTracks,
        asAbsoluteStreamIndex(hlsAudioTrackIndex ?? defaultAudioAbsoluteIndex(audioTracks)),
    );
    return resolved.track ? [resolved.track] : [];
}

export interface QualityCapReservation {
    effectiveBudgetBps: number | undefined;
    audioReservationBps: number | undefined;
}

/**
 * The effective budget AND the audio reservation together — the single
 * helper both the encode (ffmpeg-transcode.service.ts) and the manifest
 * (playback.service.ts) call, so they can never derive different numbers.
 *
 * When audio is COPIED (not transcoded) alongside a cap-active job — the one
 * way that happens is subtitle burn-in, which forces a video transcode while
 * leaving HLS-compatible audio copy-eligible — the flat 20% reservation isn't
 * enough: a copied 640k AC-3 or ~1.5M E-AC-3 track would blow straight
 * through it while the video budget calc still assumed only the reservation
 * was spent. In that case the reservation is bumped to the LARGEST actually
 * DELIVERED track's real bitrate (an unknown bitrate falls back to the flat
 * reservation, same as the copy-vs-transcode decision in playback.service.ts
 * does).
 */
export function computeQualityCapReservation(
    cap: QualityCap | undefined,
    sourceHeight: number | undefined,
    serverMaxHeight: number | undefined,
    audioIsCopied: boolean,
    deliveredAudioBitrates: ReadonlyArray<number | undefined>,
): QualityCapReservation {
    const effectiveBudgetBps = computeEffectiveBudgetBps(cap, sourceHeight, serverMaxHeight);
    const baseReservationBps = computeAudioReservationBps(effectiveBudgetBps);

    if (baseReservationBps === undefined || !audioIsCopied) {
        return { effectiveBudgetBps, audioReservationBps: baseReservationBps };
    }

    const largestDeliveredBps =
        deliveredAudioBitrates.length > 0
            ? Math.max(
                  ...deliveredAudioBitrates.map((bps) =>
                      bps && bps > 0 ? bps : baseReservationBps,
                  ),
              )
            : baseReservationBps;

    return {
        effectiveBudgetBps,
        audioReservationBps: Math.max(baseReservationBps, largestDeliveredBps),
    };
}
