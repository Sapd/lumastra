// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The eligibility predicate for the provider-artwork backfill MUST agree with
 * what the read/fetch path actually picks. `buildOverrideAwareMetadataLateralJoin`
 * (:555) is `ORDER BY <preferred first, then chain priority> LIMIT 1` — ONE
 * winning row. A plain `EXISTS (... provider IN (chain) ...)` admits items whose
 * only path lives on a LOSING chain provider; those enrol and can never
 * complete. These tests lock the winning-row shape in.
 *
 * Every case passes an EXPLICIT provider chain so the assertions do not depend
 * on runtime config.
 */

import { describe, it, expect } from 'vitest';
import {
    buildProviderArtworkPathExpr,
    buildWinningProviderArtworkPathFilter,
    buildProviderChainOrderExpr,
} from './provider-metadata.builder.js';

const CHAIN = ['aggregated', 'tmdb', 'tvdb'];

describe('buildProviderArtworkPathExpr', () => {
    it('uses still_path / still for thumb — never thumb_path', () => {
        const expr = buildProviderArtworkPathExpr('thumb', 'pm');
        expect(expr).toBe(`COALESCE(pm.metadata->>'still_path', pm.metadata->'artwork'->>'still')`);
        expect(expr).not.toContain('thumb_path');
    });

    it('uses poster_path / poster for poster', () => {
        expect(buildProviderArtworkPathExpr('poster', 'pm')).toBe(
            `COALESCE(pm.metadata->>'poster_path', pm.metadata->'artwork'->>'poster')`,
        );
    });

    it('rejects an unsafe alias', () => {
        expect(() => buildProviderArtworkPathExpr('poster', 'pm; DROP TABLE x')).toThrow();
    });
});

describe('buildProviderChainOrderExpr', () => {
    it('ranks the per-item preferred_provider first, then chain priority', () => {
        const order = buildProviderChainOrderExpr(CHAIN, 'pm.provider', 'mi.preferred_provider');
        expect(order).toContain(
            'CASE WHEN mi.preferred_provider IS NOT NULL AND pm.provider = mi.preferred_provider THEN 0 ELSE 1 END',
        );
        expect(order).toContain("WHEN pm.provider = 'aggregated' THEN 0");
        expect(order).toContain("WHEN pm.provider = 'tmdb' THEN 1");
        expect(order).toContain("WHEN pm.provider = 'tvdb' THEN 2");
    });
});

describe('buildWinningProviderArtworkPathFilter', () => {
    it('picks the winning row FIRST and tests it second (not a bare EXISTS)', () => {
        const sqlText = buildWinningProviderArtworkPathFilter('poster', CHAIN);
        // The LIMIT 1 must be inside the inner subselect, before the path test.
        const limitIdx = sqlText.indexOf('LIMIT 1');
        const coalesceIdx = sqlText.indexOf('COALESCE(win.metadata');
        expect(limitIdx).toBeGreaterThan(-1);
        expect(coalesceIdx).toBeGreaterThan(limitIdx);
    });

    it('includes aggregated in the provider list (the chain always ranks it first)', () => {
        const sqlText = buildWinningProviderArtworkPathFilter('poster', CHAIN);
        expect(sqlText).toContain("'aggregated'");
        expect(sqlText).toContain("pm.provider IN ('aggregated', 'tmdb', 'tvdb')");
    });

    it('defaults the media id and preferred-provider expressions to alias mi', () => {
        const sqlText = buildWinningProviderArtworkPathFilter('backdrop', CHAIN);
        expect(sqlText).toContain('pm.media_id = mi.id');
        expect(sqlText).toContain('mi.preferred_provider');
    });

    it('uses still_path for the thumb lane', () => {
        const sqlText = buildWinningProviderArtworkPathFilter('thumb', CHAIN);
        expect(sqlText).toContain("win.metadata->>'still_path'");
        expect(sqlText).toContain("win.metadata->'artwork'->>'still'");
    });

    it('returns a never-true predicate for an empty chain rather than matching everything', () => {
        expect(buildWinningProviderArtworkPathFilter('poster', [])).toBe('false');
    });

    it('rejects an unsafe mediaIdExpr', () => {
        expect(() =>
            buildWinningProviderArtworkPathFilter('poster', CHAIN, 'mi.id) OR 1=1 --'),
        ).toThrow();
    });
});
