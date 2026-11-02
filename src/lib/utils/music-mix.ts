// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { MusicTrack } from '$lib/schemas/music';
import type { MusicCluster } from '$lib/schemas/api-music-responses';

/** Shuffle a copy so preview order remains stable. */
export function shuffledTracks(tracks: MusicTrack[]): MusicTrack[] {
    const result = [...tracks];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

/** Stable labels shared by the home rail and full gallery. */
export function collectionLabels(clusters: MusicCluster[]): Map<number, string> {
    const labels = new Map<number, string>();
    const groups = new Map<string, typeof clusters>();
    for (const cluster of clusters) {
        const label = cluster.label || 'Library mix';
        const group = groups.get(label) ?? [];
        group.push(cluster);
        groups.set(label, group);
    }
    const suffixes = ['II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    for (const [label, group] of groups) {
        [...group]
            .sort((a, b) => b.trackCount - a.trackCount || a.id - b.id)
            .forEach((cluster, index) =>
                labels.set(
                    cluster.id,
                    index === 0 ? label : `${label} ${suffixes[index - 1] ?? index + 1}`,
                ),
            );
    }
    return labels;
}
