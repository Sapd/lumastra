// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { channelEpgStatus } from './channel-epg-status.js';

describe('channelEpgStatus', () => {
    it('counts a name match without an EPG channel id as matched (bare playlist)', () => {
        expect(channelEpgStatus({ epgMatchConfidence: 0.9, epgMatchSignals: ['name_exact'] })).toBe(
            'matched',
        );
    });

    it('marks a guide shared from a sibling feed', () => {
        expect(
            channelEpgStatus({
                epgMatchConfidence: 0.855,
                epgMatchSignals: ['name_exact', 'backup_propagation'],
            }),
        ).toBe('shared');
    });

    it('flags a match below the review threshold as low confidence', () => {
        expect(channelEpgStatus({ epgMatchConfidence: 0.6, epgChannelId: 'x' })).toBe('low');
        expect(
            channelEpgStatus({ epgMatchConfidence: 0.7, epgMatchSignals: ['backup_propagation'] }),
        ).toBe('low');
    });

    it('treats an EPG channel id without a confidence (tvg-id link) as matched', () => {
        expect(channelEpgStatus({ epgChannelId: 'orb.de' })).toBe('matched');
    });

    it('is unmatched with neither', () => {
        expect(channelEpgStatus({})).toBe('unmatched');
    });
});
