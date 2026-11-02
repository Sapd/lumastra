// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
    COUNT_BUCKETS,
    countBucket,
    countBucketDidNotGrow,
    countBucketRank,
} from './count-bucket.js';
import { adaptMusicHygiene } from './adapters.js';
import { MUSIC_HYGIENE_FINDINGS } from '$lib/shared/music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';

describe('countBucket', () => {
    it('maps each boundary to its band', () => {
        expect([0, 1].map(countBucket)).toEqual(['1', '1']);
        expect([2, 5].map(countBucket)).toEqual(['2-5', '2-5']);
        expect([6, 20].map(countBucket)).toEqual(['6-20', '6-20']);
        expect([21, 100].map(countBucket)).toEqual(['21-100', '21-100']);
        expect([101, 1000].map(countBucket)).toEqual(['101-1000', '101-1000']);
        expect([1001, 10000].map(countBucket)).toEqual(['1001-10000', '1001-10000']);
        expect([10001, 40000].map(countBucket)).toEqual(['10000+', '10000+']);
    });

    /**
     * Extending the range was only safe because it added bands ABOVE the old top
     * one. Every producer's existing fingerprints below 100 had to come out
     * byte-identical, or the eleven count-BEARING adapters would have churned
     * their stored fingerprints for no reason and `adapters.test.ts`'s `'2-5'` /
     * `'6-20'` literals would have been quietly re-pointed at new bands.
     *
     * This pins the pre-existing half of the vocabulary as data rather than
     * leaving it as an assumption of the change.
     *
     * Revert-check (CROSS-WIRE): move any lower edge — `n <= 20` to `n <= 25`,
     * or reorder the first four entries of `COUNT_BUCKETS` — and this fails.
     */
    it('leaves every band boundary at or below 100 exactly where it was', () => {
        expect(COUNT_BUCKETS.slice(0, 4)).toEqual(['1', '2-5', '6-20', '21-100']);
        const lower = [0, 1, 2, 5, 6, 20, 21, 100].map(countBucket);
        expect(lower).toEqual(['1', '1', '2-5', '2-5', '6-20', '6-20', '21-100', '21-100']);
    });

    /**
     * The order is what `countBucketDidNotGrow` reads, so it is not cosmetic.
     *
     * Revert-check (INVERT): reverse `COUNT_BUCKETS` and this fails, along with
     * every shrink/growth assertion below.
     */
    it('lists the bands smallest first, so the index is the rank', () => {
        const ranks = [1, 3, 10, 50, 500, 5000, 50000].map((n) => countBucketRank(countBucket(n)));
        expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(COUNT_BUCKETS).toHaveLength(7);
    });

    /**
     * The reason the range reaches 10,000 at all.
     *
     * The top band is terminal — `acked_fingerprint` is carried forward while the
     * ack holds, so nothing can outrank an ack taken there. That is only harmless
     * while the ceiling sits above the scale the producers operate at, and at
     * five bands it did not: the reference catalogue reports 1,234 for one
     * music-hygiene finding, which made `100+` the NORMAL band and the
     * fingerprint effectively constant.
     *
     * The scenario, as one assertion: ack 1,234, re-tag down to 50, then a bad
     * import pushes it to 40,000. Under the old five bands the first and last
     * were the same string and the growth was silent.
     *
     * Revert-check (CROSS-WIRE, not delete): drop the two bands above
     * `'101-1000'` and collapse `countBucket` to `return '101-1000'` past 100 —
     * this fails on the 40,000 comparison while the boundary test above still
     * passes, because that one only pins edges at or below 100.
     */
    it('outranks a backlog that climbs from the band an operator acked at', () => {
        const acked = countBucket(1234);
        const afterRetagging = countBucket(50);
        const afterBadImport = countBucket(40000);

        expect(countBucketDidNotGrow(acked, afterRetagging)).toBe(true);
        expect(countBucketDidNotGrow(acked, afterBadImport)).toBe(false);
        expect(countBucketRank(afterBadImport)).toBeGreaterThan(countBucketRank(acked));
    });

    /**
     * `'100+'` was the top band before the range was extended. It is not a member
     * any more, so it ranks as a non-band and its ack drops once instead of
     * comparing against a rank it no longer has — the one-time deploy churn,
     * pinned so it reads as a decision rather than a surprise.
     */
    it('treats the retired `100+` label as a non-band', () => {
        expect(countBucketRank('100+')).toBe(-1);
        expect(countBucketDidNotGrow('100+', '21-100')).toBe(false);
    });
});

describe('countBucketDidNotGrow', () => {
    it('is true for a band that shrank or stayed put', () => {
        expect(countBucketDidNotGrow('10000+', '21-100')).toBe(true);
        expect(countBucketDidNotGrow('10000+', '1')).toBe(true);
        expect(countBucketDidNotGrow('101-1000', '21-100')).toBe(true);
        expect(countBucketDidNotGrow('6-20', '6-20')).toBe(true);
    });

    /**
     * Revert-check (INVERT): flip `liveRank <= ackedRank` to `>=` and this fails
     * while the shrink cases above still pass — the pair is what pins the
     * DIRECTION, which a one-sided test cannot.
     */
    it('is false for a band that grew', () => {
        expect(countBucketDidNotGrow('21-100', '101-1000')).toBe(false);
        expect(countBucketDidNotGrow('101-1000', '1001-10000')).toBe(false);
        expect(countBucketDidNotGrow('1001-10000', '10000+')).toBe(false);
        expect(countBucketDidNotGrow('1', '2-5')).toBe(false);
    });

    /**
     * The inertness guarantee. Scalar fingerprints must keep plain equality
     * semantics, or an alert that flipped `open` → `half-open` would silently
     * stay acked.
     */
    it('is false whenever either side is not a band', () => {
        expect(countBucketDidNotGrow(null, '10000+')).toBe(false);
        expect(countBucketDidNotGrow('open', 'half-open')).toBe(false);
        expect(countBucketDidNotGrow('10000+', 'open')).toBe(false);
        expect(countBucketDidNotGrow('open', '1')).toBe(false);
        // `adaptLiveTv` prefixes its band — a near-miss that must NOT compare.
        expect(countBucketDidNotGrow('warnings:100+', 'warnings:1')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Who inherits shrink-tolerance, structurally
// ---------------------------------------------------------------------------

/**
 * `countBucketDidNotGrow` only ever fires for a producer that satisfies BOTH
 * halves of a condition it never states: the fingerprint is a bare
 * `COUNT_BUCKETS` member (so both ranks resolve) AND the alert omits `count` (so
 * `reconcile` takes the fingerprint arm instead of the `acked_count` watermark).
 *
 * That makes shrink-tolerance opt-in BY OMISSION. A future count-less producer
 * that reaches for `countBucket()` inherits an ack that survives a shrinking
 * population, silently, with no decision recorded anywhere. Two bugs already
 * fixed in this plan have exactly that shape — a section-map guard that
 * enumerated BRANCHES instead of producers, and a source registration nothing
 * asserted — and both were invisible to every test that only asserted about
 * inputs it already knew.
 *
 * So enumerate the producer side out of the adapter SOURCE, via the TypeScript
 * AST rather than a hand-maintained list: every object literal whose
 * `fingerprint` is a direct `countBucket(...)` call, tagged with whether the
 * same literal declares `count`. A new count-less one fails the assertion below
 * and has to be argued for.
 */
const ADAPTERS_PATH = new URL('./adapters.ts', import.meta.url);

interface BucketProducer {
    /** The literal head of the `id` property — `'music-hygiene:'`, `'integrity:all'`. */
    idPrefix: string;
    /** Whether the same object literal declares `count`, which routes reconcile
     *  to the watermark arm and away from any band comparison. */
    hasCount: boolean;
}

interface BucketSites {
    /** `fingerprint: countBucket(n)` — a bare band, the only form that compares. */
    bare: BucketProducer[];
    /** `fingerprint: \`warnings:${countBucket(n)}\`` — a band inside a template,
     *  which `countBucketRank` correctly refuses to rank. */
    prefixedCount: number;
    /** Any other use of `countBucket`, which this analysis cannot classify. */
    unclassified: string[];
}

function isCountBucketCall(node: ts.Node): node is ts.CallExpression {
    return (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'countBucket'
    );
}

function propertyNamed(
    obj: ts.ObjectLiteralExpression,
    name: string,
): ts.ObjectLiteralElementLike | undefined {
    return obj.properties.find(
        (p) => p.name != null && ts.isIdentifier(p.name) && p.name.text === name,
    );
}

/** The literal, non-interpolated head of an `id` initializer. */
function idPrefixOf(obj: ts.ObjectLiteralExpression): string {
    const id = propertyNamed(obj, 'id');
    if (id == null || !ts.isPropertyAssignment(id)) return '(no id)';
    const init = id.initializer;
    if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
    if (ts.isTemplateExpression(init)) return init.head.text;
    return '(computed id)';
}

/** The `fingerprint:` property assignment a node sits in, walking out through a
 *  template literal if the band was interpolated into one. */
function fingerprintHost(call: ts.CallExpression): {
    assignment: ts.PropertyAssignment;
    viaTemplate: boolean;
} | null {
    let node: ts.Node = call;
    let viaTemplate = false;
    for (let hop = 0; hop < 4 && node.parent != null; hop++) {
        const parent: ts.Node = node.parent;
        if (
            ts.isPropertyAssignment(parent) &&
            ts.isIdentifier(parent.name) &&
            parent.name.text === 'fingerprint'
        ) {
            return { assignment: parent, viaTemplate };
        }
        if (ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent)) viaTemplate = true;
        node = parent;
    }
    return null;
}

function readBucketSites(): BucketSites {
    const source = readFileSync(ADAPTERS_PATH, 'utf8');
    const sourceFile = ts.createSourceFile(
        'adapters.ts',
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
    );

    const sites: BucketSites = { bare: [], prefixedCount: 0, unclassified: [] };

    const visit = (node: ts.Node): void => {
        if (isCountBucketCall(node)) {
            const host = fingerprintHost(node);
            const obj = host?.assignment.parent;
            if (host == null || obj == null || !ts.isObjectLiteralExpression(obj)) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                sites.unclassified.push(`adapters.ts:${line + 1}`);
            } else if (host.viaTemplate) {
                sites.prefixedCount++;
            } else {
                sites.bare.push({
                    idPrefix: idPrefixOf(obj),
                    hasCount: propertyNamed(obj, 'count') != null,
                });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    return sites;
}

function everyFinding(n: number): MusicHygieneCounts {
    const out = {} as MusicHygieneCounts;
    for (const finding of MUSIC_HYGIENE_FINDINGS) out[finding] = n;
    return out;
}

describe('count-band producers that inherit shrink-tolerance', () => {
    const sites = readBucketSites();

    /**
     * The analysis has to see every `countBucket` call, or the guard below is
     * enumerating a subset it cannot name. A producer that hoisted the band into
     * a local (`const fp = countBucket(n); … fingerprint: fp`) would slip past a
     * shape-matching walk silently — so fail loudly instead, naming the line.
     */
    it('classifies every countBucket call in adapters.ts', () => {
        expect(sites.unclassified, 'unclassified countBucket call site(s)').toEqual([]);
        expect(sites.bare.length).toBeGreaterThan(10);
        // `adaptLiveTvImport`'s `warnings:${…}` — a band that deliberately does
        // not compare, so it must be seen and excluded rather than never seen.
        expect(sites.prefixedCount).toBeGreaterThan(0);
    });

    /**
     * THE guard. Shrink-tolerance reaches exactly the producers that band their
     * fingerprint and omit `count` — nothing else in `adapters.ts` may join them
     * without a decision.
     *
     * Revert-check (CROSS-WIRE, not delete): add a throwaway count-less producer
     * to `adapters.ts` —
     *
     *     { id: 'throwaway:all', fingerprint: countBucket(n), type: 'integrity' }
     *
     * — and this fails naming `throwaway:`. Adding the same producer WITH
     * `count` leaves it passing, which is the distinction the guard exists to
     * make. (Run and restore byte-identically.)
     */
    it('is exactly the music-hygiene findings', () => {
        const countless = sites.bare.filter((p) => !p.hasCount).map((p) => p.idPrefix);
        expect(countless).toEqual(['music-hygiene:']);
    });

    /**
     * The structural half above names one SITE; `adaptMusicHygiene` fans it out
     * over `MUSIC_HYGIENE_FINDINGS`. Pin the four ids it actually emits, and both
     * properties that put them under `countBucketDidNotGrow`, at the seam — the
     * adapter's output — rather than trusting the source shape alone.
     */
    it('fans that one site out to two actionable hierarchy alerts', () => {
        const alerts = adaptMusicHygiene(everyFinding(1234));

        expect(alerts.map((a) => a.id).sort()).toEqual(
            ['music-hygiene:music-album-no-artist', 'music-hygiene:music-track-no-artist'].sort(),
        );
        for (const alert of alerts) {
            expect(alert.count, `${alert.id} must omit count`).toBeUndefined();
            expect(countBucketRank(alert.fingerprint), `${alert.id} band`).toBeGreaterThanOrEqual(
                0,
            );
        }
    });

    /**
     * The other side of the same coin: every count-BEARING band producer is on
     * the watermark arm, where the fingerprint is never consulted. That is what
     * made extending the band range safe for the other eleven sites, so assert it
     * rather than leaving it in the commit message.
     */
    it('leaves every other band producer on the count watermark', () => {
        const bearing = sites.bare.filter((p) => p.hasCount);
        expect(bearing.length).toBe(sites.bare.length - 1);
        expect(bearing.every((p) => p.idPrefix !== 'music-hygiene:')).toBe(true);
    });
});
