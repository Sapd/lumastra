// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The count-band fingerprint vocabulary, and the ORDER of its bands.
 *
 * Extracted from `adapters.ts` so `reconcile.ts` can read the order without
 * importing the adapter module — `reconcile` is on the read path and `adapters`
 * pulls in the whole query layer.
 *
 * ## Why the order is load-bearing
 *
 * An aggregate alert fingerprints on the BAND its count falls in, so ordinary
 * drift inside a band never re-fires an ack and a material change of scale does.
 * `reconcile` held that ack by fingerprint EQUALITY, which is symmetric — it
 * cannot tell a backlog that grew from one that shrank.
 *
 * So an operator who acked "1,234 track titles match their file name"
 * (`1001-10000`) and then spent an afternoon re-tagging down to 50 (`21-100`)
 * had the item re-surface, unacked, BECAUSE the situation improved. Comparing
 * ranks instead of strings is what makes "no worse than what I accepted"
 * expressible.
 *
 * ## Why the range reaches 10,000
 *
 * The top band is TERMINAL: nothing outranks it, and `acked_fingerprint` is
 * carried forward unchanged while the ack holds, so an ack taken in the top band
 * can never be outgrown. That is unavoidable — every finite band list has a
 * ceiling — but it is only harmless while the ceiling sits ABOVE the scale the
 * producers actually operate at.
 *
 * At five bands it did not. The reference catalogue reports 1,234 for one
 * music-hygiene finding, so `100+` was not an exceptional band there, it was the
 * NORMAL one: the fingerprint was effectively constant, banding conveyed no
 * information, and "re-fires on a material change of scale" was a promise the
 * code could not keep. An operator could ack 1,234, re-tag down to 50, and a
 * later bad import could push it to 40,000 in silence.
 *
 * Three more bands put the ceiling at 10,000. An ack in `10000+` still cannot be
 * outgrown, and that residual is accepted deliberately: at that scale the ack
 * means "I accept that essentially my whole library is untagged", which is a
 * standing decision rather than a backlog. Two bounds contain the rest —
 * a population reaching ZERO resolves the alert and clears the ack outright
 * (`resolveAlerts` flips the row, and `reconcile`'s `ackHeld` requires
 * `prior?.status === 'acked'`), and the only count-LESS band producers are the
 * four `severity: 'info'` music-hygiene findings, which `summarize()` never lets
 * degrade the board verdict.
 *
 * ### What extending cost
 *
 * Only the bands ABOVE 100 changed, so every existing boundary (1 / 5 / 20 /
 * 100) and every existing label below `100+` is byte-identical — pinned by
 * `count-bucket.test.ts`, not assumed.
 *
 * The eleven count-BEARING producers are unaffected in the way that matters:
 * `reconcile` holds their ack against the `acked_count` WATERMARK
 * (`d.count <= prior.acked_count`) and never consults the fingerprint, so a
 * relabelled band cannot re-activate them. The one-time churn is confined to
 * count-less band alerts acked at the old `100+` — at most the four
 * music-hygiene findings — which lose that ack once on deploy and re-surface as
 * `info` for a re-ack. (A page rendered before the deploy also has one stale ack
 * click, since `ackAlert` guards on `fingerprint`; a refresh fixes it.)
 */

/** The bands, smallest first. The index IS the rank. */
export const COUNT_BUCKETS = [
    '1',
    '2-5',
    '6-20',
    '21-100',
    '101-1000',
    '1001-10000',
    '10000+',
] as const;

export type CountBucket = (typeof COUNT_BUCKETS)[number];

/** The band `n` falls in — an aggregate alert's fingerprint. */
export function countBucket(n: number): CountBucket {
    if (n <= 1) return '1';
    if (n <= 5) return '2-5';
    if (n <= 20) return '6-20';
    if (n <= 100) return '21-100';
    if (n <= 1000) return '101-1000';
    if (n <= 10000) return '1001-10000';
    return '10000+';
}

/**
 * The rank of a fingerprint in the band order, or `-1` when it is not a band at
 * all.
 *
 * Most fingerprints are NOT bands — `open`, `half-open`, `class-no-leader`,
 * `warnings:6-20`, per-rule hashes. `-1` is what keeps the comparison in
 * `reconcile` inert for them, so they keep plain equality semantics.
 *
 * A RETIRED band label (`100+`, from before the range reached 10,000) is not a
 * member either, so it also ranks `-1` and its ack drops once rather than
 * comparing against a rank it no longer has. That is the intended one-time
 * churn, not an oversight.
 */
export function countBucketRank(fingerprint: string): number {
    return (COUNT_BUCKETS as readonly string[]).indexOf(fingerprint);
}

/**
 * Whether `live` is a count band no LARGER than the band `acked` was taken at.
 *
 * False whenever either side is not a band, so a non-aggregate alert is
 * unaffected. Equality is already handled by the caller's fingerprint check;
 * this exists for the strictly-smaller case.
 */
export function countBucketDidNotGrow(acked: string | null, live: string): boolean {
    if (acked === null) return false;
    const ackedRank = countBucketRank(acked);
    const liveRank = countBucketRank(live);
    if (ackedRank < 0 || liveRank < 0) return false;
    return liveRank <= ackedRank;
}
