// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { stationKey } from './backup-group-detector';

describe('stationKey', () => {
    it.each([
        ['LRV-alpha', 'LRV alpha'],
        ['KWFneo', 'KWF_neo'],
        ['Bildwelt TV', 'BildweltTV'],
        ['Terra Geo Wild', 'TerraGeo Wild'],
        ['VDD TÜRK', 'VDD TURK'],
        ['Pino Jr.', 'PINO JR'],
        ['QX 1', 'QX1'],
        ['CA: KSN 1', 'CA:KSN 1'],
    ])('%s and %s are one station', (a, b) => {
        expect(stationKey(a)).toBe(stationKey(b));
    });

    it.each([
        ['Kanal Neun', 'Kanal Neun+'],
        ['Game', 'Game+'],
        ['o.tz', 'OTZ'],
        ['Arena 1', 'Arena 2'],
    ])('%s and %s stay apart', (a, b) => {
        expect(stationKey(a)).not.toBe(stationKey(b));
    });
});
