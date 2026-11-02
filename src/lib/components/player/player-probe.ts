// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PlayabilityResponse } from '$lib/schemas/api-playability.js';
import type { TrackRecommendation } from './playerStore.svelte';
import type { SelectionPreferenceSnapshot } from './preferences-sync.svelte';

export type ProbeVersion = PlayabilityResponse['versions'][number];
export type PlayerProbe = PlayabilityResponse & {
    activeVersion: ProbeVersion;
    preferenceSnapshot?: SelectionPreferenceSnapshot;
};
export type PlayerMethod = NonNullable<ProbeVersion['playMethod']>;

/** A file-specific probe refreshes one version without losing the version picker. */
export function selectPlayerProbe(
    probe: PlayabilityResponse,
    previous?: PlayabilityResponse | null,
): PlayerProbe | null {
    const activeVersion = probe.versions.find((v) => v.fileId === probe.activeFileId);
    if (!activeVersion) return null;
    const versions =
        previous?.mediaId === probe.mediaId
            ? [
                  ...previous.versions.map(
                      (v) => probe.versions.find((n) => n.fileId === v.fileId) ?? v,
                  ),
                  ...probe.versions.filter(
                      (v) => !previous.versions.some((p) => p.fileId === v.fileId),
                  ),
              ]
            : probe.versions;
    return { ...probe, versions, activeVersion };
}

/** Convert absolute wire audio indices to the player's relative display indices. */
export function probeTrackRecommendation(probe: PlayerProbe): TrackRecommendation | undefined {
    const pick = probe.recommended;
    if (!pick) return undefined;
    const audio = probe.activeVersion.tracks.audio.find(
        (a) => a.absoluteIndex === pick.audioStreamIndex,
    );
    if (!audio) return undefined;
    return {
        preferenceSnapshot: probe.preferenceSnapshot,
        audio_track_index: audio.index,
        subtitle_track_index: pick.subtitleId
            ? probe.activeVersion.tracks.subtitles.find((s) => s.id === pick.subtitleId)?.index
            : undefined,
        reason: pick.reason,
    };
}
