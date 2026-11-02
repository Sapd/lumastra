// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({ LIVETV_CAP_FALLBACK: 'source' as 'refuse' | 'source' }));
vi.mock('$lib/server/config.js', () => ({ config: configMock }));

const { getLiveTvCapFallback } = await import('./livetv-cap-policy.js');

describe('getLiveTvCapFallback', () => {
    beforeEach(() => {
        configMock.LIVETV_CAP_FALLBACK = 'source';
    });

    it('reads the operator policy from config, not process.env', () => {
        // Reading env directly made the setting invisible to settings.json and to the
        // admin Settings UI, which is how a `refuse` default could take Live TV down
        // with nothing in the UI to turn it back on.
        configMock.LIVETV_CAP_FALLBACK = 'refuse';
        expect(getLiveTvCapFallback()).toBe('refuse');
    });

    it('defaults to serving the source rather than failing playback', () => {
        // The refusal cases are ordinary — an unreadable probe, an HDR channel, a
        // sub-540p channel, a spent encoder budget — and every one of them plays fine
        // uncapped. Failing closed turns a quality preference into a dead channel.
        expect(getLiveTvCapFallback()).toBe('source');
    });
});
