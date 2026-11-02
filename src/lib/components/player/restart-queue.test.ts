// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { RestartQueue } from './restart-queue';

describe('RestartQueue — queued restarts (latest wins, never dropped)', () => {
    it('collapses repeated quality requests into one', () => {
        const q = new RestartQueue();
        q.queueQuality();
        q.queueQuality();
        expect(q.takePending()).toEqual({ kind: 'quality', position: null });
        expect(q.takePending()).toBeNull();
    });

    it('a later seek replaces an earlier one', () => {
        const q = new RestartQueue();
        q.queueSeek(10);
        q.queueSeek(42);
        expect(q.takePending()).toEqual({ kind: 'seek', position: 42 });
    });

    it('quality + seek (either order) keeps the quality change at the seek target', () => {
        const a = new RestartQueue();
        a.queueQuality();
        a.queueSeek(30);
        expect(a.takePending()).toEqual({ kind: 'quality', position: 30 });

        const b = new RestartQueue();
        b.queueSeek(30);
        b.queueQuality();
        expect(b.takePending()).toEqual({ kind: 'quality', position: 30 });
    });
});

describe('RestartQueue — resume snapshot', () => {
    it('reuses the first snapshot for every restart in a burst', () => {
        // S1: the follow-up restart read the torn-down element (0:00, paused).
        const q = new RestartQueue();
        const first = q.captureResume(() => ({ position: 14, play: true }));
        const read = vi.fn(() => ({ position: 0, play: false }));
        q.queueQuality();
        const second = q.captureResume(read);
        expect(read).not.toHaveBeenCalled();
        expect(second).toEqual(first);
    });

    it('applies a queued seek target as the resume position', () => {
        const q = new RestartQueue();
        q.captureResume(() => ({ position: 14, play: true }));
        expect(q.captureResume(() => ({ position: 0, play: false }), 90)).toEqual({
            position: 90,
            play: true,
        });
    });

    it('settles only when nothing is queued', () => {
        const q = new RestartQueue();
        q.captureResume(() => ({ position: 14, play: true }));
        q.queueQuality();
        q.settle();
        expect(q.currentResume()).not.toBeNull();
        q.takePending();
        q.settle();
        expect(q.currentResume()).toBeNull();
        expect(q.captureResume(() => ({ position: 50, play: false }))).toEqual({
            position: 50,
            play: false,
        });
    });

    it('noteSeek moves the in-flight resume position', () => {
        const q = new RestartQueue();
        q.noteSeek(5); // no burst in flight: no-op
        expect(q.currentResume()).toBeNull();
        q.captureResume(() => ({ position: 14, play: true }));
        q.noteSeek(120);
        expect(q.currentResume()).toEqual({ position: 120, play: true });
    });

    it('reset drops everything and bumps the generation', () => {
        const q = new RestartQueue();
        const gen = q.generation;
        q.captureResume(() => ({ position: 14, play: true }));
        q.queueQuality();
        q.reset();
        expect(q.hasPending()).toBe(false);
        expect(q.currentResume()).toBeNull();
        expect(q.generation).toBe(gen + 1);
    });
});
