// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Inputs and outputs shared by every caller of `buildPlaybackStartInfo` that
 * answers "what would a start with these capabilities decide": POST
 * /play-sessions and POST /media/{id}/playability. One module so the probe and
 * the start cannot drift apart.
 */

import type { LumastraInfoResponse } from '$lib/schemas/api-playback-responses.js';
import type { PlaybackCapabilities } from '$lib/schemas/playback-capabilities.js';
import type { PathScopedCapabilities } from '$lib/components/player/codec-types.js';
import type { DeviceCapabilities } from '$lib/server/utils/media-compatibility.js';
import {
    normalizeSubtitleCodec,
    supportedSubtitleFormats,
    ASS_CODECS,
    PGS_CODECS,
    VOBSUB_CODECS,
    TEXT_CODECS,
} from '$lib/components/player/subtitle-utils.js';
import { playbackCapabilitiesToProfile } from '$lib/server/utils/info.utils.js';
import { pathScopedFromDeviceCaps } from './info.service.js';

/**
 * The caps inputs POST /play-sessions feeds to `buildPlaybackStartInfo` for a
 * video start. POST /media/{id}/playability uses this SAME function, so the
 * answer a probe gives for a file is the one a start with those capabilities
 * decides on.
 */
export function startDecisionInputs(capabilities: PlaybackCapabilities | undefined): {
    clientCaps: DeviceCapabilities;
    pathScopedCaps: PathScopedCapabilities;
    clientType: 'native';
} {
    const profile = playbackCapabilitiesToProfile(capabilities);
    profile.supportsHlsCopyReload = capabilities?.hlsCopyReload ?? false;
    const pathCaps = pathScopedFromDeviceCaps(profile, 'native');
    const subtitleFormats = supportedSubtitleFormats(profile.subtitleFormats);
    const supportsVtt = subtitleFormats.has('vtt') || subtitleFormats.has('webvtt');
    pathCaps.subtitleRendering = {
        vtt: supportsVtt,
        ass: ASS_CODECS.some((codec) => subtitleFormats.has(codec)),
        pgs: PGS_CODECS.some((codec) => subtitleFormats.has(codec)),
        vobsub: VOBSUB_CODECS.some((codec) => subtitleFormats.has(codec)),
        burnInRequired: [
            ...new Set([
                ...pathCaps.subtitleRendering.burnInRequired,
                ...ASS_CODECS,
                ...PGS_CODECS,
                ...VOBSUB_CODECS,
                ...(!supportsVtt ? TEXT_CODECS : []),
            ]),
        ].filter((codec) => !subtitleFormats.has(normalizeSubtitleCodec(codec))),
    };
    return { clientCaps: profile, pathScopedCaps: pathCaps, clientType: 'native' };
}

/**
 * The tracks to start on, as the wire values a start body takes back: an absolute
 * audio stream index and a stable subtitle id. Absent when the server has no opinion.
 */
export function recommendedStreamIndexes(
    info: Pick<LumastraInfoResponse, 'tracks' | 'recommended_tracks' | 'active_file_id'>,
): { audioStreamIndex?: number; subtitleId?: string } | undefined {
    const recommended = info.recommended_tracks;
    if (!recommended) return undefined;
    return {
        audioStreamIndex: info.tracks.audio.find(
            (track) => track.index === recommended.audio_track_index,
        )?.absoluteIndex,
        subtitleId:
            recommended.subtitle_id ??
            (recommended.subtitle_track_index === undefined
                ? 'none'
                : `${info.active_file_id}:${recommended.subtitle_track_index}`),
    };
}
