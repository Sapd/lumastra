// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseM3u } from './m3u-parser.js';
import { processChannels } from './auto-processor.js';
import { matchChannels, type ExistingChannel } from './channel-matcher.js';

/**
 * Integration test: parses the sample.m3u and restructured.m3u fixtures,
 * runs them through the auto-processor and channel matcher, and verifies
 * the smart diffing produces correct results for a realistic CDN migration.
 */
describe('refresh integration: sample → restructured M3U', () => {
    const fixturesDir = join(import.meta.dirname, '../../__tests__/fixtures/livetv');
    const sampleContent = readFileSync(join(fixturesDir, 'sample.m3u'), 'utf8');
    const restructuredContent = readFileSync(join(fixturesDir, 'restructured.m3u'), 'utf8');

    // Parse and process both M3U files
    const sampleParsed = parseM3u(sampleContent);
    const sampleProcessed = processChannels(sampleParsed.channels);

    const restructuredParsed = parseM3u(restructuredContent);
    const restructuredProcessed = processChannels(restructuredParsed.channels);

    // Simulate existing channels from the sample M3U (as if they were already imported)
    function buildExistingChannels(): ExistingChannel[] {
        return sampleProcessed.channels.map((ch, idx) => ({
            id: `existing-${idx}`,
            name: ch.original.name,
            streamUrl: ch.original.streamUrl,
            epgChannelId: ch.original.tvgId ?? undefined,
            qualityTier: ch.qualityTier ?? 'sd',
            categoryId: undefined,
            categoryName: ch.category ?? undefined,
            backupGroupId: ch.backupGroupKey ?? undefined,
            sortOrder: idx,
            isVisible: true,
            adminDisplayName: idx === 0 ? 'My Custom Name' : undefined,
            countryCode: ch.original.countryCode ?? 'de',
            consecutiveAbsences: 0,
        }));
    }

    it('parses both fixtures successfully', () => {
        expect(sampleParsed.channels.length).toBeGreaterThan(0);
        expect(restructuredParsed.channels.length).toBeGreaterThan(0);
    });

    it('matches channels despite CDN URL changes', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        // Most channels should match (same tvg-id even though URLs changed to new-cdn)
        expect(result.matched.length).toBeGreaterThan(0);

        // Verify a specific match: Nordwelle FHD should match despite URL change
        const nordwelleMatch = result.matched.find(
            (m) => m.existingChannel.epgChannelId === 'Nordwelle.de',
        );
        expect(nordwelleMatch).toBeDefined();
        expect(nordwelleMatch!.newChannel.original.streamUrl).toContain('new-cdn.example');
    });

    it('detects new channels (Siebenstern, SAT.4)', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        const newTvgIds = result.newChannels.map((ch) => ch.original.tvgId);
        expect(newTvgIds).toContain('Siebenstern.de');
        expect(newTvgIds).toContain('Sat4.de');
    });

    it('detects removed channels (ZAVO 1, Orb Cinema Action)', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        const removedIds = result.removedChannels.map((ch) => ch.epgChannelId);
        expect(removedIds).toContain('ZAVO1.de');
        expect(removedIds).toContain('OrbCinemaAction.de');
    });

    it('detects URL changes for matched channels', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        // All matched channels should have URL changes (old: provider.example → new: new-cdn.example)
        expect(result.stats.urlChangedCount).toBeGreaterThan(0);
    });

    it('does not flag as mass restructure (most channels still match)', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        // Most channels match, so this shouldn't be flagged
        expect(result.massRestructure).toBe(false);
    });

    it('reports correct stats', () => {
        const existing = buildExistingChannels();
        const result = matchChannels(existing, restructuredProcessed.channels);

        expect(result.stats.totalExisting).toBe(existing.length);
        expect(result.stats.totalNew).toBe(restructuredProcessed.channels.length);
        expect(result.stats.newCount).toBe(result.newChannels.length);
        expect(result.stats.removedCount).toBe(result.removedChannels.length);
        // At least 2 new (Siebenstern, SAT.4) and 2 removed (ZAVO, Orb Cinema Action)
        expect(result.stats.newCount).toBeGreaterThanOrEqual(2);
        expect(result.stats.removedCount).toBeGreaterThanOrEqual(2);
    });
});
