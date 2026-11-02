// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for status mapping utilities
 */

import { describe, it, expect, vi } from 'vitest';
import {
    getSimpleStatusLabel,
    mapSeasonRequestStatus,
    mapJellyseerrStatusCode,
    isMediaAvailable,
    isMediaPartiallyAvailable,
    isMediaProcessing,
    isMediaPending,
    getHighestPriorityStatus,
    isPreRelease,
    isInCinemas,
    isReleased,
    getStatusMessage,
    STATUS_PRIORITY,
} from './status-mapping';
import { MediaStatus, RequestStatus } from '$lib/server/jellyseerr';

// Mock paraglide messages
vi.mock('$lib/paraglide/messages.js', () => ({
    req_available: () => 'Available',
    req_unavailable: () => 'Unavailable',
    req_downloading: () => 'Downloading',
    req_synching: () => 'Synching',
    req_processing: () => 'Being processed',
    req_searching: () => 'Searching',
    request_sending: () => 'Pending',
    req_queued: () => 'Queued',
    req_paused: () => 'Paused',
    request_status_importing: () => 'Importing',
    request_status_monitored_searching: () => 'Monitored',
}));

describe('getSimpleStatusLabel', () => {
    it('returns available for request status 5', () => {
        expect(getSimpleStatusLabel(5, MediaStatus.UNKNOWN)).toBe('available');
    });

    it('returns available for MediaStatus.AVAILABLE', () => {
        expect(getSimpleStatusLabel(0, MediaStatus.AVAILABLE)).toBe('available');
    });

    it('returns partially_available for MediaStatus.PARTIALLY_AVAILABLE', () => {
        expect(getSimpleStatusLabel(0, MediaStatus.PARTIALLY_AVAILABLE)).toBe(
            'partially_available',
        );
    });

    it('returns processing for MediaStatus.PROCESSING', () => {
        expect(getSimpleStatusLabel(0, MediaStatus.PROCESSING)).toBe('processing');
    });

    it('returns pending for MediaStatus.PENDING', () => {
        expect(getSimpleStatusLabel(0, MediaStatus.PENDING)).toBe('pending');
    });

    it('returns awaiting_approval for RequestStatus.PENDING_APPROVAL', () => {
        expect(getSimpleStatusLabel(RequestStatus.PENDING_APPROVAL, MediaStatus.UNKNOWN)).toBe(
            'awaiting_approval',
        );
    });

    it('returns declined for RequestStatus.DECLINED', () => {
        expect(getSimpleStatusLabel(RequestStatus.DECLINED, MediaStatus.UNKNOWN)).toBe('declined');
    });

    it('returns unknown for unrecognized statuses', () => {
        expect(getSimpleStatusLabel(999, MediaStatus.UNKNOWN)).toBe('unknown');
    });
});

describe('mapSeasonRequestStatus', () => {
    it('maps pending to pending', () => {
        expect(mapSeasonRequestStatus('pending')).toBe('pending');
    });

    it('maps processing to searching', () => {
        expect(mapSeasonRequestStatus('processing')).toBe('searching');
    });

    it('maps approved to synching', () => {
        expect(mapSeasonRequestStatus('approved')).toBe('synching');
    });

    it('maps declined to unavailable', () => {
        expect(mapSeasonRequestStatus('declined')).toBe('unavailable');
    });

    it('returns null for undefined', () => {
        expect(mapSeasonRequestStatus(undefined)).toBeNull();
    });

    it('returns null for unknown status', () => {
        expect(mapSeasonRequestStatus('unknown')).toBeNull();
    });
});

describe('mapJellyseerrStatusCode', () => {
    it('maps 5 to available', () => {
        expect(mapJellyseerrStatusCode(5)).toBe('available');
    });

    it('maps 3+ to downloading', () => {
        expect(mapJellyseerrStatusCode(3)).toBe('downloading');
        expect(mapJellyseerrStatusCode(4)).toBe('downloading');
    });

    it('maps 2 to pending', () => {
        expect(mapJellyseerrStatusCode(2)).toBe('pending');
    });

    it('returns null for 0 or 1', () => {
        expect(mapJellyseerrStatusCode(0)).toBeNull();
        expect(mapJellyseerrStatusCode(1)).toBeNull();
    });
});

describe('MediaStatus helpers', () => {
    describe('isMediaAvailable', () => {
        it('returns true for AVAILABLE', () => {
            expect(isMediaAvailable(MediaStatus.AVAILABLE)).toBe(true);
        });

        it('returns false for other statuses', () => {
            expect(isMediaAvailable(MediaStatus.PENDING)).toBe(false);
            expect(isMediaAvailable(undefined)).toBe(false);
        });
    });

    describe('isMediaPartiallyAvailable', () => {
        it('returns true for PARTIALLY_AVAILABLE', () => {
            expect(isMediaPartiallyAvailable(MediaStatus.PARTIALLY_AVAILABLE)).toBe(true);
        });

        it('returns false for other statuses', () => {
            expect(isMediaPartiallyAvailable(MediaStatus.AVAILABLE)).toBe(false);
        });
    });

    describe('isMediaProcessing', () => {
        it('returns true for PROCESSING', () => {
            expect(isMediaProcessing(MediaStatus.PROCESSING)).toBe(true);
        });

        it('returns false for other statuses', () => {
            expect(isMediaProcessing(MediaStatus.AVAILABLE)).toBe(false);
        });
    });

    describe('isMediaPending', () => {
        it('returns true for PENDING', () => {
            expect(isMediaPending(MediaStatus.PENDING)).toBe(true);
        });

        it('returns false for other statuses', () => {
            expect(isMediaPending(MediaStatus.AVAILABLE)).toBe(false);
        });
    });
});

describe('getHighestPriorityStatus', () => {
    it('returns available as highest priority', () => {
        expect(getHighestPriorityStatus(['pending', 'available', 'downloading'])).toBe('available');
    });

    it('returns synching over downloading', () => {
        expect(getHighestPriorityStatus(['downloading', 'synching', 'pending'])).toBe('synching');
    });

    it('returns downloading over queued', () => {
        expect(getHighestPriorityStatus(['queued', 'downloading', 'pending'])).toBe('downloading');
    });

    it('returns pending for empty array', () => {
        expect(getHighestPriorityStatus([])).toBe('pending');
    });

    it('returns single status if only one provided', () => {
        expect(getHighestPriorityStatus(['unavailable'])).toBe('unavailable');
    });
});

describe('STATUS_PRIORITY', () => {
    // Assert ORDERING (higher = further along) rather than magic numbers — the
    // canonical STATUS_RANK in $lib/shared/request-status owns the absolute
    // values and may renumber; the contract these tests guard is the ordering.
    it('has available as the highest priority of all statuses', () => {
        const max = Math.max(...Object.values(STATUS_PRIORITY));
        expect(STATUS_PRIORITY.available).toBe(max);
    });

    it('has unavailable as the lowest priority of all statuses', () => {
        const min = Math.min(...Object.values(STATUS_PRIORITY));
        expect(STATUS_PRIORITY.unavailable).toBe(min);
    });

    it('has correct ordering for download states', () => {
        expect(STATUS_PRIORITY.downloading).toBeGreaterThan(STATUS_PRIORITY.queued);
        expect(STATUS_PRIORITY.queued).toBeGreaterThan(STATUS_PRIORITY.searching);
    });
});

describe('Release status helpers', () => {
    describe('isPreRelease', () => {
        it('returns true for tba', () => {
            expect(isPreRelease('tba')).toBe(true);
        });

        it('returns true for announced', () => {
            expect(isPreRelease('announced')).toBe(true);
        });

        it('returns false for released', () => {
            expect(isPreRelease('released')).toBe(false);
        });

        it('returns false for undefined', () => {
            expect(isPreRelease(undefined)).toBe(false);
        });
    });

    describe('isInCinemas', () => {
        it('returns true for inCinemas', () => {
            expect(isInCinemas('inCinemas')).toBe(true);
        });

        it('returns false for released', () => {
            expect(isInCinemas('released')).toBe(false);
        });
    });

    describe('isReleased', () => {
        it('returns true for released', () => {
            expect(isReleased('released')).toBe(true);
        });

        it('returns true for continuing', () => {
            expect(isReleased('continuing')).toBe(true);
        });

        it('returns true for ended', () => {
            expect(isReleased('ended')).toBe(true);
        });

        it('returns false for tba', () => {
            expect(isReleased('tba')).toBe(false);
        });

        it('returns false for inCinemas', () => {
            expect(isReleased('inCinemas')).toBe(false);
        });
    });
});

describe('getStatusMessage', () => {
    it('returns correct message for available', () => {
        expect(getStatusMessage('available')).toBe('Available');
    });

    it('returns correct message for unavailable', () => {
        expect(getStatusMessage('unavailable')).toBe('Unavailable');
    });

    it('returns correct message for downloading', () => {
        expect(getStatusMessage('downloading')).toBe('Downloading');
    });

    it('returns correct message for synching', () => {
        expect(getStatusMessage('synching')).toBe('Being processed');
    });

    it('returns correct message for searching', () => {
        expect(getStatusMessage('searching')).toBe('Searching');
    });

    it('returns correct message for pending', () => {
        expect(getStatusMessage('pending')).toBe('Pending');
    });

    it('returns correct message for queued', () => {
        expect(getStatusMessage('queued')).toBe('Queued');
    });

    it('returns correct message for paused', () => {
        expect(getStatusMessage('paused')).toBe('Paused');
    });

    it('returns correct message for importing', () => {
        expect(getStatusMessage('importing')).toBe('Importing');
    });

    it('returns correct message for monitored', () => {
        expect(getStatusMessage('monitored')).toBe('Monitored');
    });
});
