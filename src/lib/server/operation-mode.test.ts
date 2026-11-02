// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Operation Mode Helper Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
const mockFeatures = {
    jellyfin: true,
    liveTV: true,
};

const mockConnectionStatus = {
    isJellyfinAvailable: vi.fn(() => true),
    isDegradedMode: vi.fn(() => false),
};

vi.mock('./config.js', () => ({
    features: mockFeatures,
}));

vi.mock('./services/connection-status.service.js', () => ({
    connectionStatus: mockConnectionStatus,
}));

// Import after mocks are set up
const { operationMode } = await import('./operation-mode.js');

describe('operationMode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset to defaults
        mockFeatures.jellyfin = true;
        mockFeatures.liveTV = true;
        mockConnectionStatus.isJellyfinAvailable.mockReturnValue(true);
        mockConnectionStatus.isDegradedMode.mockReturnValue(false);
    });

    describe('isJellyfinEnabled', () => {
        it('returns true when JELLYFINURL and JELLYFINAPIKEY are set', () => {
            mockFeatures.jellyfin = true;
            expect(operationMode.isJellyfinEnabled).toBe(true);
        });

        it('returns false when Jellyfin is not configured', () => {
            mockFeatures.jellyfin = false;
            expect(operationMode.isJellyfinEnabled).toBe(false);
        });
    });

    describe('isJellyfinAvailable', () => {
        it('returns true when Jellyfin is connected', () => {
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(true);
            expect(operationMode.isJellyfinAvailable).toBe(true);
        });

        it('returns false when Jellyfin is disconnected', () => {
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(false);
            expect(operationMode.isJellyfinAvailable).toBe(false);
        });
    });

    describe('isDegraded', () => {
        it('returns true when DB healthy + Jellyfin disconnected', () => {
            mockConnectionStatus.isDegradedMode.mockReturnValue(true);
            expect(operationMode.isDegraded).toBe(true);
        });

        it('returns false when all services healthy', () => {
            mockConnectionStatus.isDegradedMode.mockReturnValue(false);
            expect(operationMode.isDegraded).toBe(false);
        });
    });

    describe('isLiveTVEnabled', () => {
        it('returns true when liveTV feature is enabled', () => {
            mockFeatures.liveTV = true;
            expect(operationMode.isLiveTVEnabled).toBe(true);
        });

        it('returns false when liveTV feature is disabled', () => {
            mockFeatures.liveTV = false;
            expect(operationMode.isLiveTVEnabled).toBe(false);
        });
    });

    describe('canLiveTV', () => {
        it('returns true when liveTV feature is enabled', () => {
            mockFeatures.liveTV = true;
            expect(operationMode.canLiveTV).toBe(true);
        });

        it('returns false when liveTV feature is disabled', () => {
            mockFeatures.liveTV = false;
            expect(operationMode.canLiveTV).toBe(false);
        });

        it('does not depend on Jellyfin availability', () => {
            mockFeatures.liveTV = true;
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(false);
            expect(operationMode.canLiveTV).toBe(true);
        });
    });

    describe('named operation modes', () => {
        it('isJellyfinEnhanced: true when Jellyfin enabled AND available', () => {
            mockFeatures.jellyfin = true;
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(true);
            expect(operationMode.isJellyfinEnhanced).toBe(true);
            expect(operationMode.isStandalone).toBe(false);
            expect(operationMode.isJellyfinUnreachable).toBe(false);
        });

        it('isJellyfinUnreachable: true when Jellyfin enabled but unavailable', () => {
            mockFeatures.jellyfin = true;
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(false);
            expect(operationMode.isJellyfinEnhanced).toBe(false);
            expect(operationMode.isStandalone).toBe(false);
            expect(operationMode.isJellyfinUnreachable).toBe(true);
        });

        it('isStandalone: true when Jellyfin not enabled', () => {
            mockFeatures.jellyfin = false;
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(false);
            expect(operationMode.isJellyfinEnhanced).toBe(false);
            expect(operationMode.isStandalone).toBe(true);
            expect(operationMode.isJellyfinUnreachable).toBe(false);
        });

        it('exactly one mode is true at any time', () => {
            // Full Jellyfin
            mockFeatures.jellyfin = true;
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(true);
            expect(
                [
                    operationMode.isJellyfinEnhanced,
                    operationMode.isStandalone,
                    operationMode.isJellyfinUnreachable,
                ].filter(Boolean).length,
            ).toBe(1);

            // Degraded
            mockConnectionStatus.isJellyfinAvailable.mockReturnValue(false);
            expect(
                [
                    operationMode.isJellyfinEnhanced,
                    operationMode.isStandalone,
                    operationMode.isJellyfinUnreachable,
                ].filter(Boolean).length,
            ).toBe(1);

            // Standalone
            mockFeatures.jellyfin = false;
            expect(
                [
                    operationMode.isJellyfinEnhanced,
                    operationMode.isStandalone,
                    operationMode.isJellyfinUnreachable,
                ].filter(Boolean).length,
            ).toBe(1);
        });
    });
});
