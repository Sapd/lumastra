// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stable sonic-cluster ids across `sonic-clustering` runs.
 *
 * KMeans labels its clusters 0..K-1 in whatever order it converges, so the
 * raw index says nothing about which sound a cluster is. Every run used to
 * store that raw index as `cluster_id`, and a device that saved "cluster 3"
 * got a different sound after the next library change.
 *
 * Each new cluster inherits the id of the previous cluster it shares the most
 * tracks with (greedy, one-to-one, at least MIN_OLD_SHARE of the old cluster's
 * tracks). The rest get ids never issued before, so a stored id either means
 * the same sound or is gone — it never silently points somewhere else.
 */

/** A raw cluster inherits an old id only when it holds at least this share of the old cluster. */
export const MIN_OLD_SHARE = 0.3;

export interface StableClusterIdResult {
    /** Raw KMeans index → stable id to store. */
    idByRaw: Map<number, number>;
    /** Ids issued by this run (ascending). */
    issued: number[];
    /** Old ids carried over to a new cluster. */
    kept: number[];
    /** Old ids no new cluster inherited (ascending). */
    retired: number[];
}

/**
 * @param previous       media id → stable id of the last run (empty on a fresh install).
 * @param fresh          media id → raw KMeans index of this run.
 * @param highestIssued  Highest id ever issued for this model, -1 when none.
 */
export function matchStableClusterIds(
    previous: ReadonlyMap<string, number>,
    fresh: ReadonlyMap<string, number>,
    highestIssued: number,
): StableClusterIdResult {
    const oldSize = new Map<number, number>();
    for (const oldId of previous.values()) oldSize.set(oldId, (oldSize.get(oldId) ?? 0) + 1);

    // overlap[raw][old] = tracks in both.
    const overlap = new Map<number, Map<number, number>>();
    for (const [mediaId, raw] of fresh) {
        const oldId = previous.get(mediaId);
        if (oldId === undefined) continue;
        let row = overlap.get(raw);
        if (!row) overlap.set(raw, (row = new Map()));
        row.set(oldId, (row.get(oldId) ?? 0) + 1);
    }

    const candidates: { raw: number; old: number; count: number }[] = [];
    for (const [raw, row] of overlap) {
        for (const [old, count] of row) {
            if (count / (oldSize.get(old) ?? 1) >= MIN_OLD_SHARE) {
                candidates.push({ raw, old, count });
            }
        }
    }
    candidates.sort((a, b) => b.count - a.count || a.raw - b.raw || a.old - b.old);

    const idByRaw = new Map<number, number>();
    const takenOld = new Set<number>();
    for (const c of candidates) {
        if (idByRaw.has(c.raw) || takenOld.has(c.old)) continue;
        idByRaw.set(c.raw, c.old);
        takenOld.add(c.old);
    }

    const rawIndices = [...new Set(fresh.values())].sort((a, b) => a - b);
    let next = Math.max(highestIssued, ...oldSize.keys()) + 1;
    const issued: number[] = [];
    for (const raw of rawIndices) {
        if (idByRaw.has(raw)) continue;
        idByRaw.set(raw, next);
        issued.push(next++);
    }

    // Stable iteration order (by raw index) for callers and tests.
    const ordered = new Map(rawIndices.map((raw) => [raw, idByRaw.get(raw)!]));
    return {
        idByRaw: ordered,
        issued,
        kept: [...takenOld],
        retired: [...oldSize.keys()].filter((id) => !takenOld.has(id)).sort((a, b) => a - b),
    };
}
