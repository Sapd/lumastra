// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { liveStartFixture } from './livetv-start.fixture.js';

it.each(['internal', 'v1'] as const)('builds a current Live TV stream URL on %s', (surface) => {
    const result = liveStartFixture('session', surface);
    const prefix = surface === 'v1' ? '/api/v1' : '/api';
    expect(result.delivery.url).toBe(
        `${prefix}/livetv/channels/${result.stationId}/stream/master.m3u8?grant=original`,
    );
});
