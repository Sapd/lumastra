// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LiveHlsDelivery } from '$lib/schemas/livetv-delivery.js';
import { LIVETV_RUNGS } from '$lib/shared/livetv-rungs.js';
import type { TranscodingProfile } from '$lib/types/playback.js';
import * as m from '$lib/paraglide/messages.js';
import { isLiveTvQualityChoice, type LiveTvQualityChoice } from './livetv-quality-preference.js';

/** Player profiles derived from the server-owned fixed ladder. */
export const LIVE_TV_QUALITY_PROFILES: readonly TranscodingProfile[] = LIVETV_RUNGS.map((rung) => ({
    maxBitrate: rung.maxBitrate,
    width: Math.round((rung.height * 16) / 9),
    height: rung.height,
    label: `${rung.height}p - ${rung.maxBitrate / 1_000_000} Mbps`,
    mode: 'fixed' as const,
}));

/**
 * The ladder id a player profile stands for, or null if it is not a rung.
 *
 * Looked up from LIVETV_RUNGS rather than rebuilt as
 * `${height}p${maxBitrate / 1e6}m`: that reconstruction only happens to match
 * today's ids, and a rung at a fractional Mbps (or any id scheme change) would
 * silently start emitting a quality the server rejects.
 */
export function liveTvRungIdForProfile(profile: TranscodingProfile): LiveTvQualityChoice | null {
    const rung = LIVETV_RUNGS.find(
        (candidate) =>
            candidate.height === profile.height && candidate.maxBitrate === profile.maxBitrate,
    );
    return rung && isLiveTvQualityChoice(rung.id) ? rung.id : null;
}

/** The quality choice a profile selects in the Live TV menu, or null if it selects none. */
export function liveTvChoiceForProfile(profile: TranscodingProfile): LiveTvQualityChoice | null {
    if (profile.mode === 'original') return 'original';
    if (profile.mode === 'auto') return 'adaptive';
    return liveTvRungIdForProfile(profile);
}

/** The quality the server applied to a Live TV delivery (its `live-hls` delivery fields). */
export type LiveTvAppliedQuality = Pick<
    LiveHlsDelivery,
    | 'rungId'
    | 'requestedMaxBitrateBps'
    | 'appliedMaxBitrateBps'
    | 'appliedMaxHeight'
    | 'reason'
    | 'adaptive'
>;

export interface LiveTvQualityState {
    selection: LiveTvQualityChoice;
    adaptive: boolean;
    rungId: string | null;
    requestedMaxBitrateBps: number | null;
    appliedMaxBitrateBps: number | null;
    appliedMaxHeight: number | null;
    reason: LiveHlsDelivery['reason'];
    /** The synchronized ladder the server applied when Adaptive was granted. */
    ladder: LiveTvAdaptiveLadder | null;
}

export type LiveTvAdaptiveLadder = NonNullable<LiveHlsDelivery['adaptive']>;

export function liveTvQualityState(
    info: LiveTvAppliedQuality,
    selection: LiveTvQualityChoice,
): LiveTvQualityState {
    const pickedRung =
        selection !== 'server' && selection !== 'original' && selection !== 'adaptive';
    // A rung the server did NOT apply must not stay checked in the menu.
    //
    // `appliedMaxBitrateBps === null` means no encoder is capping this viewer. Under
    // LIVETV_CAP_FALLBACK=source that is a 200, not an error, so nothing else moves the
    // selection — the menu kept a checkmark on 720p while the footer read
    // "Original · no encoder capacity free", and the preference was persisted as though
    // the pick had been honoured.
    //
    // `source_within_cap` is excluded on purpose: there the ceiling WAS honoured — the
    // source already sits under it, so no encode is needed and the request was granted
    // in substance. Only the reasons that mean "we could not do what you asked"
    // (hdr_source, unprobeable, capacity, insufficient_ladder) move the selection.
    const rungNotApplied =
        pickedRung && info.appliedMaxBitrateBps === null && info.reason !== 'source_within_cap';
    const effectiveSelection =
        (selection === 'adaptive' && info.adaptive === undefined) ||
        (pickedRung && info.requestedMaxBitrateBps === null) ||
        rungNotApplied
            ? 'original'
            : selection;
    return {
        selection: effectiveSelection,
        adaptive: info.adaptive !== undefined,
        rungId: info.rungId,
        requestedMaxBitrateBps: info.requestedMaxBitrateBps,
        appliedMaxBitrateBps: info.appliedMaxBitrateBps,
        appliedMaxHeight: info.appliedMaxHeight,
        reason: info.reason,
        ladder: info.adaptive ?? null,
    };
}

export function appliedLiveTvProfile(
    requested: TranscodingProfile | null,
    info: LiveTvAppliedQuality,
): TranscodingProfile | null {
    if (info.appliedMaxBitrateBps === null) {
        return info.reason === 'source_within_cap' ? requested : null;
    }
    return (
        LIVE_TV_QUALITY_PROFILES.find(
            (profile) => profile.maxBitrate === info.appliedMaxBitrateBps,
        ) ?? null
    );
}

/**
 * One line describing what the viewer is actually receiving, and why.
 *
 * Every `reason` the server can emit is mapped explicitly. The `default` branch is
 * unreachable for known reasons but keeps a proxy that learns a new one from
 * rendering a blank status.
 */
export function formatLiveTvQualityStatus(state: LiveTvQualityState | null): string | null {
    if (!state) return null;
    if (state.adaptive) return m.livetv_quality_status_adaptive();
    if (state.appliedMaxBitrateBps !== null) {
        const bitrate = String(state.appliedMaxBitrateBps / 1_000_000);
        return state.appliedMaxHeight
            ? m.livetv_quality_status_capped_with_height({
                  height: String(state.appliedMaxHeight),
                  bitrate,
              })
            : m.livetv_quality_status_capped({ bitrate });
    }
    switch (state.reason) {
        case 'source_within_cap':
            return m.livetv_quality_status_source_within_cap();
        case 'hdr_source':
            return m.livetv_quality_status_hdr_source();
        case 'unprobeable':
            return m.livetv_quality_status_unprobeable();
        case 'capacity':
            return m.livetv_quality_status_capacity();
        case 'below_ladder':
            return m.livetv_quality_status_below_ladder();
        case 'insufficient_ladder':
            return m.livetv_quality_status_insufficient_ladder();
        default:
            return m.livetv_quality_status_original();
    }
}

/**
 * The adaptive variant being played, from the decoded picture height.
 *
 * Height rather than an hls.js level index so native HLS (Safari) reports it too:
 * the media element is the only thing both clients expose. The ladder never upscales
 * and its rungs differ in height, so a height names one rung — except when Original
 * joins the ladder at a height a rung shares; the encoded rung wins that tie, which
 * is only wrong for the experimental Original variant.
 */
export function currentAdaptiveVariant(
    ladder: LiveTvAdaptiveLadder,
    decodedResolution: string | null,
): { kind: 'rung'; id: string } | { kind: 'original' } | null {
    const height = Number(decodedResolution?.split('x')[1]);
    if (!Number.isFinite(height) || height <= 0) return null;
    const rung = ladder.rungs.find((candidate) => candidate.height === height);
    if (rung) return { kind: 'rung', id: rung.id };
    return ladder.includesOriginal ? { kind: 'original' } : null;
}

/** The server's default Live TV quality as the menu shows it ("Adaptive", "720p · 4 Mbps"). */
export function formatLiveTvDefaultQuality(value: string | undefined): string {
    if (value === undefined || value === 'adaptive') return m.livetv_quality_adaptive();
    if (value === 'original') return m.livetv_quality_status_original();
    const rung = LIVETV_RUNGS.find((candidate) => candidate.id === value);
    return rung
        ? m.livetv_quality_status_capped_with_height({
              height: String(rung.height),
              bitrate: String(rung.maxBitrate / 1_000_000),
          })
        : value;
}
