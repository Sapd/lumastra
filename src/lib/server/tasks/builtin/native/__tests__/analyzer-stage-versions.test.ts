// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The analyzer tracks its two detector groups as independent stages in
 * `media_item_stage_state`, so a cheap per-item detector change no longer
 * forces the expensive season-level acoustic pass to re-run library-wide.
 *
 * The split is by DETECTOR GROUP, not by segment type, because one chromaprint
 * fingerprint pass yields both Intro and credits evidence — a per-type split
 * would have to fingerprint every season twice.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
    ACOUSTIC_PROCESSING_VERSION,
    PROCESSING_VERSION,
} from '../lumastra-intro-analyzer.js';

describe('analyzer stage identities', () => {
    it('uses distinct stage ids namespaced under the plugin id', () => {
        expect(ANALYZER_VISUAL_STAGE_ID).toBe('lumastra-intro-analyzer:visual');
        expect(ANALYZER_ACOUSTIC_STAGE_ID).toBe('lumastra-intro-analyzer:acoustic');
        expect(ANALYZER_VISUAL_STAGE_ID).not.toBe(ANALYZER_ACOUSTIC_STAGE_ID);
    });

    it('versions the two stages independently', () => {
        // The 2026-08-17 frame-accurate blackframe + generic final-chapter work
        // changed only visual detection, so only that counter moves. Bumping
        // both would re-fingerprint the whole library for no benefit.
        expect(VISUAL_PROCESSING_VERSION).toBe(5);
        expect(ACOUSTIC_PROCESSING_VERSION).toBe(4);
        // Migration 16.212.0 seeded both stages at the legacy value, so the
        // acoustic stage must stay there or that seeding is invalidated.
        expect(ACOUSTIC_PROCESSING_VERSION).toBe(PROCESSING_VERSION);
    });
});

const source = readFileSync(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'lumastra-intro-analyzer.ts'),
    'utf8',
);

describe('stage-aware completion marking', () => {
    it('markAnalyzed takes an explicit stageId rather than hardcoding PLUGIN_ID', () => {
        const start = source.indexOf('async function markAnalyzed(');
        expect(start).toBeGreaterThanOrEqual(0);
        const body = source.slice(start, source.indexOf('\n}', start));
        expect(body).toContain('stageId: string');
        expect(body).toContain('stageId,');
    });

    it('never writes the legacy combined stage id any more', () => {
        expect(source).not.toContain('stageId: PLUGIN_ID');
    });

    it('marks completion only with stage-specific ids and versions', () => {
        const calls = source.match(/await markAnalyzed\([\s\S]{0,260}?\);/g) ?? [];
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call).toMatch(/ANALYZER_(VISUAL|ACOUSTIC)_STAGE_ID/);
            expect(call).toMatch(/(VISUAL|ACOUSTIC)_PROCESSING_VERSION/);
        }
    });

    // Independence of visual completion from acoustic success is tested with
    // real stage rows in intro-analyzer/bounded-drain.integration.test.ts.

    it('marks acoustic only when the fingerprint pass actually ran', () => {
        // chromaOK is also true when chromaprint is DISABLED; marking then would
        // leave those episodes permanently un-fingerprinted if it is enabled later.
        expect(source).toContain('if (chromaRan) {');
    });

    it('drains eligibility against the visual stage', () => {
        const start = source.indexOf('? await getUnanalyzedSeasons(');
        expect(start).toBeGreaterThanOrEqual(0);
        const call = source.slice(start, source.indexOf(');', start));
        expect(call).toContain('ANALYZER_VISUAL_STAGE_ID');
        expect(call).toContain('VISUAL_PROCESSING_VERSION');
    });

    it('marks the acoustic stage after a season fingerprint pass', () => {
        expect(source).toContain('ANALYZER_ACOUSTIC_STAGE_ID');
        expect(source).toContain('ACOUSTIC_PROCESSING_VERSION');
    });
});

describe('regressions the first cut of this refactor introduced', () => {
    it('drops the acoustic eligibility term when chromaprint is disabled', () => {
        // With chromaprint off the pass never runs, so no acoustic row is ever
        // written. Counting that stage as outstanding kept those seasons
        // permanently eligible: they pinned the head of the ORDER BY + LIMIT
        // slice, and because the scheduled drain is `catchup` (one slice, then
        // break) every season past the first batch was never reached again.
        const start = source.indexOf('async function getUnanalyzedSeasons(');
        const body = source.slice(start, source.indexOf('\n}', start));
        expect(body).toContain('acousticEnabled: boolean');
        expect(body).toContain('${acousticEnabled}');

        const call = source.slice(source.indexOf('? await getUnanalyzedSeasons('));
        expect(call.slice(0, 400)).toContain('config.chromaprintDetection !== false');
    });

    it('keeps a separate episode set per stage so a tombstone cannot strand the other', () => {
        // Using the visually-filtered set for BOTH meant a visually-tombstoned
        // episode never received an acoustic row: its season stayed
        // acousticStale forever and re-ran the fingerprint pass every drain.
        expect(source).toContain('const acousticEpisodeIds = episodeRows.filter');
        expect(source).toContain('visual_blocked');
        expect(source).toContain('acoustic_blocked');
    });

    it('sweeps the visual stage, not the write-orphaned legacy id', () => {
        // coversStages drives the framework sweep. Left on the legacy id it
        // produced a backlog that could never shrink, so shouldSkipGlobalEnqueue
        // re-enqueued global runs forever and the admin coverage grid showed the
        // whole episode library as outstanding.
        const idx = source.indexOf('coversStages: [');
        expect(idx).toBeGreaterThanOrEqual(0);
        const block = source.slice(idx, idx + 1200);
        expect(block).toContain('id: ANALYZER_VISUAL_STAGE_ID');
        expect(block).not.toContain("id: 'lumastra-intro-analyzer'");
    });

    it('quarantines the acoustic stage on BOTH chromaprint failure paths', () => {
        // one in the scheduled drain, one in the targeted season/series path
        const sites: number[] = [];
        for (let i = source.indexOf('`season-chromaprint:'); i !== -1;) {
            sites.push(i);
            i = source.indexOf('`season-chromaprint:', i + 1);
        }
        expect(sites).toHaveLength(2);
        for (const at of sites) {
            // the stage args follow the reason argument in the same call
            expect(source.slice(at, at + 200)).toContain('ANALYZER_ACOUSTIC_STAGE_ID');
        }
    });

    it('marks the acoustic stage after a targeted fingerprint pass', () => {
        // Otherwise the expensive pass an admin just paid for is invisible to
        // the scheduled drain, which re-runs it for the same season next cycle.
        expect(source).toContain("logger.warn('Targeted markAnalyzed(acoustic) failed'");
    });

    it('does not gate targeted visual marking on the fingerprint result either', () => {
        const idx = source.indexOf('const toMark: string[] = [];');
        expect(idx).toBeGreaterThanOrEqual(0);
        const block = source.slice(idx, idx + 400);
        expect(block).not.toContain('chromaOK.has(seasonId)');
    });
});
