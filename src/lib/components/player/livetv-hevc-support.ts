// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What this browser's Live TV player can do with HEVC, reported on every stream join so the
 * server can serve an HEVC channel in a form this player decodes (see the `hevc` parameter of
 * POST /livetv/playback-sessions):
 *
 * - Safari (and every iOS browser) plays Live TV through native HLS (PlaybackManager
 *   initializeHls), which takes HEVC only from fMP4 segments: `fmp4`, or `none` when the
 *   device cannot decode HEVC at all.
 * - Everything else plays through hls.js over MSE, which handles HEVC in MPEG-TS whenever MSE
 *   accepts hvc1: `any`, else `none` (Firefox, Chrome without hardware HEVC).
 *
 * The probe string is HEVC Main 10 at level 5.1, the profile of UHD HDR channels; a device
 * that only manages 8-bit HD HEVC reports `none` and gets H.264, which always plays.
 */
import type { LiveTvClientHevc } from '../../../shared/livetv-proxy-types.js';

const HEVC_MAIN10_MP4 = 'video/mp4; codecs="hvc1.2.4.L153.B0"';

interface MediaSourceLike {
    isTypeSupported?: (type: string) => boolean;
}

interface Env {
    userAgent: string;
    video: Pick<HTMLVideoElement, 'canPlayType'>;
    mediaSource: MediaSourceLike | undefined;
}

/** Same test PlayerController uses to pick native HLS (isSafari). */
const SAFARI_UA = /^((?!chrome|android).)*safari/i;

export function classifyLiveTvHevcSupport(env: Env): LiveTvClientHevc {
    const mseHevc = (() => {
        try {
            return env.mediaSource?.isTypeSupported?.(HEVC_MAIN10_MP4) === true;
        } catch {
            return false;
        }
    })();
    const nativeHls =
        SAFARI_UA.test(env.userAgent) && env.video.canPlayType('application/vnd.apple.mpegurl');
    if (nativeHls) {
        return mseHevc || env.video.canPlayType(HEVC_MAIN10_MP4) !== '' ? 'fmp4' : 'none';
    }
    return mseHevc ? 'any' : 'none';
}

let cached: LiveTvClientHevc | null | undefined;

/** This browser's answer, computed once; null outside a browser. */
export function getLiveTvHevcSupport(): LiveTvClientHevc | null {
    if (cached !== undefined) return cached;
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    try {
        const w = window as Window & {
            ManagedMediaSource?: MediaSourceLike;
            MediaSource?: MediaSourceLike;
        };
        cached = classifyLiveTvHevcSupport({
            userAgent: navigator.userAgent,
            video: document.createElement('video'),
            mediaSource: w.ManagedMediaSource ?? w.MediaSource,
        });
    } catch {
        cached = null;
    }
    return cached;
}
