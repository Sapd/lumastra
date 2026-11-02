// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Taxonomy parity tests (Slice 1).
 *
 * Verifies every mapping helper returns the documented enum for every input
 * including the null/undefined/`unknown` edges — pure, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
    taxonomyFromFinding,
    taxonomyFromCluster,
    taxonomyFromComponentStatus,
} from './task-system-health.schema.js';

describe('taxonomyFromFinding', () => {
    it('maps every finding status onto the taxonomy', () => {
        expect(taxonomyFromFinding('green')).toBe('healthy');
        expect(taxonomyFromFinding('amber')).toBe('degraded');
        expect(taxonomyFromFinding('red')).toBe('unhealthy');
        expect(taxonomyFromFinding('unknown')).toBe('unknown');
    });
});

describe('taxonomyFromCluster', () => {
    it('null → unknown', () => {
        expect(taxonomyFromCluster(null)).toBe('unknown');
    });
    it('zero online → unhealthy', () => {
        expect(taxonomyFromCluster({ totalOnline: 0, totalRegistered: 3 })).toBe('unhealthy');
    });
    it('nothing registered yet (fresh install, 0/0) → unknown, not unhealthy', () => {
        expect(taxonomyFromCluster({ totalOnline: 0, totalRegistered: 0 })).toBe('unknown');
    });
    it('online below registered → degraded', () => {
        expect(taxonomyFromCluster({ totalOnline: 2, totalRegistered: 3 })).toBe('degraded');
    });
    it('online meets/exceeds registered → healthy', () => {
        expect(taxonomyFromCluster({ totalOnline: 3, totalRegistered: 3 })).toBe('healthy');
        expect(taxonomyFromCluster({ totalOnline: 4, totalRegistered: 3 })).toBe('healthy');
    });
});

describe('taxonomyFromComponentStatus', () => {
    it('maps pass/warn/fail/undefined onto the taxonomy', () => {
        expect(taxonomyFromComponentStatus('pass')).toBe('healthy');
        expect(taxonomyFromComponentStatus('fail')).toBe('unhealthy');
        expect(taxonomyFromComponentStatus('warn')).toBe('degraded');
        expect(taxonomyFromComponentStatus(undefined)).toBe('unknown');
    });
});
