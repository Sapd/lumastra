// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The three playback-component alerts pointed their "investigate" action AND
 * their sourceRef at bare `/admin`.
 *
 * NightlyDigest renders ON /admin and links `actions.find(a => a.href)?.href ??
 * sourceRef`, so "Look at it →" navigated to the page the reader was already
 * looking at — reported from prod as the link doing nothing. A dead link on the
 * one alert the dashboard chooses to surface is worse than no link.
 */

import { describe, it, expect } from 'vitest';
import { adaptLumastraPlayback } from './adapters.js';

describe('adaptLumastraPlayback: investigate links go somewhere', () => {
    const cases = [
        { name: 'hwaccel', checks: { hwAccelOk: false, hwAccelType: 'qsv', hwAccelDetail: 'x' } },
        { name: 'ffmpeg', checks: { ffmpegOk: false } },
        { name: 'ffprobe', checks: { ffprobeOk: false } },
    ];

    for (const c of cases) {
        it(`${c.name}: never links to bare /admin, the page the digest renders on`, () => {
            const alerts = adaptLumastraPlayback(c.checks as never);
            expect(alerts.length).toBeGreaterThan(0);

            for (const a of alerts) {
                expect(a.sourceRef).not.toBe('/admin');
                for (const action of a.actions ?? []) {
                    expect(action.href).not.toBe('/admin');
                }
            }
        });
    }

    it('hwaccel points at the system health page', () => {
        const [alert] = adaptLumastraPlayback({
            hwAccelOk: false,
            hwAccelType: 'qsv',
            hwAccelDetail: 'vainfo unavailable',
        } as never);

        expect(alert.sourceRef).toBe('/admin/system/health');
        expect(alert.actions?.[0]?.href).toBe('/admin/system/health');
    });
});
