// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Maximal Marginal Relevance (MMR) re-ranking.
 *
 * Selects items that are simultaneously *relevant* to a query AND *diverse*
 * from items already chosen. Used to span multiple regions of a user's taste
 * space when the raw kNN result would otherwise cluster around one mode.
 *
 * Formula per iteration:
 *   score(i) = lambda * relevance(i) - (1 - lambda) * max_j sim(i, j)
 * where j ranges over already-selected items.
 *
 *   lambda = 1.0 → pure relevance (same as kNN)
 *   lambda = 0.5 → balanced (default)
 *   lambda = 0.0 → pure diversity (ignores relevance)
 */

export interface MmrOptions<T> {
    /** Number of items to select */
    count: number;
    /** Pre-computed relevance for each candidate (e.g. 1 - cosine_distance) */
    relevance: (item: T) => number;
    /**
     * Similarity between two candidates (typically cosine similarity).
     * Return `null` if similarity cannot be computed (e.g. missing embedding);
     * MMR will treat those candidates as maximally-similar-to-everything so
     * they lose the diversity contest rather than winning it by accident.
     */
    similarity: (a: T, b: T) => number | null;
    /** Trade-off between relevance (1.0) and diversity (0.0). Default 0.5. */
    lambda?: number;
}

export function mmrRerank<T>(candidates: T[], opts: MmrOptions<T>): T[] {
    const rawLambda = opts.lambda ?? 0.5;
    const lambda = Number.isFinite(rawLambda) ? rawLambda : 0.5;
    const rawCount = opts.count;
    if (!Number.isFinite(rawCount)) return [];
    const target = Math.min(rawCount, candidates.length);
    if (target <= 0) return [];

    const remaining = [...candidates];
    const selected: T[] = [];

    // `maxSims[i]` is `max_j sim(remaining[i], selected[j])`, carried across
    // rounds instead of recomputed inside them.
    //
    // Recomputing it was the whole cost of this function: the argmax scans
    // every remaining candidate, and re-deriving each one's max against the
    // whole selected set made the work O(n·k²) — with n = k×3 at the station
    // caller, cubic in the requested count, over full-width embedding
    // cosines. Measured on prod, /music/taste-stations/{i}/tracks: 0.95s at
    // limit=20 but 9.8s at 50, and the documented max of 100 would have been
    // far worse. Since a round only ever adds ONE item to `selected`, the
    // running max only needs updating against that one item, which is O(n·k)
    // overall and returns the identical selection.
    //
    // Seeded to -1 — below the valid cosine range — to match the baseline the
    // per-round recompute used once anything was selected. The first round
    // ignores it entirely (`diversityPenalty` is forced to 0 there), so the
    // seed cannot influence the opening pick.
    const maxSims: number[] = new Array(remaining.length).fill(-1);

    while (selected.length < target && remaining.length > 0) {
        let bestIdx = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const candidate = remaining[i];
            const rel = opts.relevance(candidate);
            // Skip candidates with non-finite relevance — they'd poison
            // `lambda*rel` to NaN and silently lose the argmax.
            if (!Number.isFinite(rel)) continue;

            // The first selection uses pure relevance; afterwards the penalty
            // is the running max. Uncomputable similarities (null) enter that
            // max as +Infinity — the candidate looks maximally similar to the
            // chosen set and thus loses the diversity term.
            const diversityPenalty = selected.length === 0 ? 0 : maxSims[i];
            const score = lambda * rel - (1 - lambda) * diversityPenalty;
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
            }
        }

        // If every remaining candidate had non-finite relevance we exit
        // rather than pretending to select index 0.
        if (bestIdx < 0) break;
        const chosen = remaining.splice(bestIdx, 1)[0];
        // Spliced in lockstep, or `maxSims` silently stops describing the
        // candidate it is indexed against — which would be invisible in the
        // output, just a slightly wrong ranking.
        maxSims.splice(bestIdx, 1);
        selected.push(chosen);

        // Fold the new selection into every survivor's running max. Skipped
        // on the final round, where nothing will read the result again.
        if (selected.length < target) {
            for (let i = 0; i < remaining.length; i++) {
                const sim = opts.similarity(remaining[i], chosen);
                const effective = sim === null ? Number.POSITIVE_INFINITY : sim;
                if (effective > maxSims[i]) maxSims[i] = effective;
            }
        }
    }

    return selected;
}
