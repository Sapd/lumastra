// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    getEpisodesWithFilesForSeason,
    getUnanalyzedSeasons,
    getFilePathForItem,
    getMediaItemInfo,
} from './intro-analysis.queries.js';

describe('intro-analysis.queries', () => {
    it('exports all query functions', () => {
        expect(typeof getEpisodesWithFilesForSeason).toBe('function');
        expect(typeof getUnanalyzedSeasons).toBe('function');
        expect(typeof getFilePathForItem).toBe('function');
        expect(typeof getMediaItemInfo).toBe('function');
    });
});
