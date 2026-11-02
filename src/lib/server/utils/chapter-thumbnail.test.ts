// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Unit tests for the chapter-thumbnail sprite-sheet resolver. */

import { describe, it, expect } from 'vitest';
import {
    computeChapterTile,
    computeNearestChapterTiles,
    pickBestTrickplayParams,
    type TrickplayTileParams,
} from './chapter-thumbnail';

// 320x180 tiles, 10s interval, 10x10 grid (100 tiles/sheet), 250 thumbnails total.
const PARAMS: TrickplayTileParams = {
    width: 320,
    height: 180,
    interval_ms: 10_000,
    tile_width: 10,
    tile_height: 10,
    thumbnail_count: 250,
};

describe('computeChapterTile', () => {
    it('maps t=0 to the first tile of sheet 0', () => {
        expect(computeChapterTile(0, PARAMS)).toEqual({
            sheetIndex: 0,
            cropLeft: 0,
            cropTop: 0,
            cropWidth: 320,
            cropHeight: 180,
        });
    });

    it('maps a mid-sheet time to the right row/col (125s -> thumb 12 -> row1 col2)', () => {
        // 125s / 10s = thumbnailIndex 12; sheet 0; col = 12 % 10 = 2; row = 1.
        const ticks = 125 * 10_000_000;
        expect(computeChapterTile(ticks, PARAMS)).toEqual({
            sheetIndex: 0,
            cropLeft: 2 * 320,
            cropTop: 1 * 180,
            cropWidth: 320,
            cropHeight: 180,
        });
    });

    it('crosses into the next sheet at the 100th thumbnail (1000s -> sheet 1, tile 0)', () => {
        const ticks = 1000 * 10_000_000;
        expect(computeChapterTile(ticks, PARAMS)).toEqual({
            sheetIndex: 1,
            cropLeft: 0,
            cropTop: 0,
            cropWidth: 320,
            cropHeight: 180,
        });
    });

    it('returns null when the time is past the last real thumbnail', () => {
        // thumbnail_count=250 -> valid indices 0..249; 250*10s = 2500s -> index 250.
        expect(computeChapterTile(2500 * 10_000_000, PARAMS)).toBeNull();
    });

    it('returns null for degenerate params (interval 0)', () => {
        expect(computeChapterTile(0, { ...PARAMS, interval_ms: 0 })).toBeNull();
    });
});

describe('computeNearestChapterTiles', () => {
    it('uses the ten-second frame for a chapter at the opening of a movie', () => {
        expect(computeNearestChapterTiles(0, PARAMS)[0]).toEqual({
            sheetIndex: 0,
            cropLeft: 320,
            cropTop: 0,
            cropWidth: 320,
            cropHeight: 180,
        });
    });

    it('keeps the exact thumbnail for chapters starting at one second or later', () => {
        expect(computeNearestChapterTiles(1 * 10_000_000, PARAMS)[0]).toEqual({
            sheetIndex: 0,
            cropLeft: 0,
            cropTop: 0,
            cropWidth: 320,
            cropHeight: 180,
        });
    });

    it('tries the exact tile, then later sheets before earlier ones', () => {
        // 125s is thumbnail 12 in a 10-tile sheet: sheet 1 is exact, then
        // sheet 2's first tile (20), and only then sheet 0's final tile (9).
        const params = { ...PARAMS, tile_width: 5, tile_height: 2, thumbnail_count: 25 };
        expect(
            computeNearestChapterTiles(125 * 10_000_000, params).map((tile) => tile.sheetIndex),
        ).toEqual([1, 2, 0]);
    });
});

describe('pickBestTrickplayParams', () => {
    it('returns null for an empty list', () => {
        expect(pickBestTrickplayParams([])).toBeNull();
    });

    it('picks the row with the largest width', () => {
        const rows = [{ width: 320 }, { width: 640 }, { width: 480 }];
        expect(pickBestTrickplayParams(rows)).toEqual({ width: 640 });
    });
});
