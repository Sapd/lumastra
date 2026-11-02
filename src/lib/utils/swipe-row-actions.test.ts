// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    REVEAL_WIDTH,
    DELETE_WIDTH,
    OPEN_COMMIT_WIDTH,
    getSwipeRowStage,
    getSwipeRowRelease,
    isCancelledByVerticalDrag,
    getRowTranslate,
    getArmProgress,
    clampDragDistance,
} from './swipe-row-actions';

describe('getSwipeRowStage', () => {
    it('is closed at rest or on a rightward drag', () => {
        expect(getSwipeRowStage(0)).toBe('closed');
        expect(getSwipeRowStage(-40)).toBe('closed');
    });

    it('is reveal once dragged left at all, up to (and including) reveal width', () => {
        expect(getSwipeRowStage(1)).toBe('reveal');
        expect(getSwipeRowStage(REVEAL_WIDTH)).toBe('reveal');
    });

    it('is armed once dragged past the reveal width', () => {
        expect(getSwipeRowStage(REVEAL_WIDTH + 1)).toBe('armed');
        expect(getSwipeRowStage(DELETE_WIDTH + 100)).toBe('armed');
    });
});

describe('getSwipeRowRelease', () => {
    it('closes when released below the open-commit width', () => {
        expect(getSwipeRowRelease(0)).toBe('close');
        expect(getSwipeRowRelease(OPEN_COMMIT_WIDTH - 1)).toBe('close');
    });

    it('opens (pins the tray) when released past open-commit width but below delete width', () => {
        expect(getSwipeRowRelease(OPEN_COMMIT_WIDTH)).toBe('open');
        expect(getSwipeRowRelease(DELETE_WIDTH - 1)).toBe('open');
    });

    it('deletes when released at or past the delete width', () => {
        expect(getSwipeRowRelease(DELETE_WIDTH)).toBe('delete');
        expect(getSwipeRowRelease(DELETE_WIDTH + 500)).toBe('delete');
    });
});

describe('isCancelledByVerticalDrag', () => {
    it('cancels when vertical movement exceeds horizontal', () => {
        expect(isCancelledByVerticalDrag(10, 20)).toBe(true);
        expect(isCancelledByVerticalDrag(-10, 30)).toBe(true);
    });

    it('does not cancel when horizontal movement exceeds vertical', () => {
        expect(isCancelledByVerticalDrag(30, 10)).toBe(false);
        expect(isCancelledByVerticalDrag(-30, 10)).toBe(false);
    });

    it('does not cancel when movements are equal', () => {
        expect(isCancelledByVerticalDrag(20, 20)).toBe(false);
    });
});

describe('getRowTranslate', () => {
    it('tracks the finger 1:1 up to the reveal width', () => {
        expect(getRowTranslate(0)).toBe(0);
        expect(getRowTranslate(50)).toBe(50);
        expect(getRowTranslate(REVEAL_WIDTH)).toBe(REVEAL_WIDTH);
    });

    it('holds at the reveal width once the drag goes further (armed phase)', () => {
        expect(getRowTranslate(REVEAL_WIDTH + 50)).toBe(REVEAL_WIDTH);
        expect(getRowTranslate(DELETE_WIDTH + 200)).toBe(REVEAL_WIDTH);
    });

    it('never goes negative for a rightward drag', () => {
        expect(getRowTranslate(-30)).toBe(0);
    });
});

describe('getArmProgress', () => {
    it('is 0 up to and including the reveal width', () => {
        expect(getArmProgress(0)).toBe(0);
        expect(getArmProgress(REVEAL_WIDTH)).toBe(0);
    });

    it('grows linearly from reveal width to delete width', () => {
        const mid = REVEAL_WIDTH + (DELETE_WIDTH - REVEAL_WIDTH) / 2;
        expect(getArmProgress(mid)).toBeCloseTo(0.5, 5);
    });

    it('caps at 1 at and beyond the delete width', () => {
        expect(getArmProgress(DELETE_WIDTH)).toBe(1);
        expect(getArmProgress(DELETE_WIDTH + 999)).toBe(1);
    });
});

describe('clampDragDistance', () => {
    it('follows the raw distance 1:1 up to the delete width', () => {
        expect(clampDragDistance(0)).toBe(0);
        expect(clampDragDistance(REVEAL_WIDTH)).toBe(REVEAL_WIDTH);
        expect(clampDragDistance(DELETE_WIDTH)).toBe(DELETE_WIDTH);
    });

    it('never goes negative for a rightward drag', () => {
        expect(clampDragDistance(-50)).toBe(0);
    });

    it('rubber-bands past the delete width instead of following 1:1', () => {
        const past = clampDragDistance(DELETE_WIDTH + 40);
        expect(past).toBeGreaterThan(DELETE_WIDTH);
        expect(past).toBeLessThan(DELETE_WIDTH + 40);
    });
});
