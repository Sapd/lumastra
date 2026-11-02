// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { determineStatusFromLinkRatio } from './series-health.service';
import {
    coverageHealthStatus,
    type SeriesEpisodeCoverage,
} from '$lib/server/database/queries/series-health.queries';

describe('determineStatusFromLinkRatio', () => {
    it('returns unknown when total is 0', () => {
        expect(determineStatusFromLinkRatio(0, 0)).toBe('unknown');
    });

    it('returns healthy when link ratio is exactly 95%', () => {
        expect(determineStatusFromLinkRatio(95, 100)).toBe('healthy');
    });

    it('returns healthy when all episodes are linked', () => {
        expect(determineStatusFromLinkRatio(24, 24)).toBe('healthy');
    });

    it('returns warning when link ratio is between 70% and 94%', () => {
        expect(determineStatusFromLinkRatio(70, 100)).toBe('warning');
        expect(determineStatusFromLinkRatio(80, 100)).toBe('warning');
        expect(determineStatusFromLinkRatio(94, 100)).toBe('warning');
    });

    it('returns mismatch when link ratio is below 70%', () => {
        expect(determineStatusFromLinkRatio(69, 100)).toBe('mismatch');
        expect(determineStatusFromLinkRatio(0, 100)).toBe('mismatch');
    });
});

describe('coverageHealthStatus', () => {
    const base: SeriesEpisodeCoverage = {
        episodesHeld: 10,
        episodesListed: 10,
        missing: 0,
        seasonsHeld: 1,
        seasonsListed: 1,
        identified: 10,
        conflicted: false,
    };

    it('is healthy when nothing listed is missing', () => {
        expect(coverageHealthStatus(base)).toBe('healthy');
    });

    it('is a notice when at most two episodes are missing', () => {
        expect(coverageHealthStatus({ ...base, missing: 2 })).toBe('notice');
    });

    it('is a warning past two missing episodes', () => {
        expect(coverageHealthStatus({ ...base, missing: 3 })).toBe('warning');
    });

    it('is a mismatch when a file sits on an unmatched episode row', () => {
        expect(coverageHealthStatus({ ...base, conflicted: true })).toBe('mismatch');
    });

    it('is unknown without a provider episode list, even when conflicted', () => {
        expect(coverageHealthStatus({ ...base, identified: 0, conflicted: true })).toBe('unknown');
    });
});
