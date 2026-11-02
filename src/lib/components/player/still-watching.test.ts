// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    recordAutoplayedEpisode,
    noteEpisodeArrival,
    startViewerActivityTracking,
    resetStillWatchingStreak,
    shouldPromptStillWatching,
} from './still-watching.js';

function stubSessionStorage(values: Map<string, string>) {
    vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    });
}

describe('still-watching streak', () => {
    const values = new Map<string, string>();

    beforeEach(() => {
        values.clear();
        stubSessionStorage(values);
    });

    it('does not prompt before any episode has auto-played', () => {
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('does not prompt after a single auto-played episode', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('prompts once two episodes have auto-played back to back', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });

    it('keeps prompting while the streak stands', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-1')).toBe(true);
        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });

    it('stops prompting once the viewer interacts', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');
        resetStillWatchingStreak();
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('needs two fresh auto-plays after an interaction, not one', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');
        resetStillWatchingStreak();
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-1')).toBe(false);
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });

    it('does not carry a streak over to a different series', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');
        expect(shouldPromptStillWatching('series-2')).toBe(false);
    });

    it('restarts counting at one when the series changes mid-streak', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-2', 'ep-x');
        expect(shouldPromptStillWatching('series-2')).toBe(false);
        recordAutoplayedEpisode('series-2', 'ep-x');
        expect(shouldPromptStillWatching('series-2')).toBe(true);
    });

    it('survives the navigation between episodes', () => {
        recordAutoplayedEpisode('series-1', 'ep-x');
        // A new /watch/<id> page re-reads the streak from storage.
        stubSessionStorage(values);
        recordAutoplayedEpisode('series-1', 'ep-x');
        stubSessionStorage(values);
        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });

    it('never prompts when session storage is unavailable', () => {
        vi.stubGlobal('sessionStorage', {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
            removeItem: () => {
                throw new Error('denied');
            },
        });
        expect(() => recordAutoplayedEpisode('series-1', 'ep-x')).not.toThrow();
        expect(() => recordAutoplayedEpisode('series-1', 'ep-x')).not.toThrow();
        expect(() => resetStillWatchingStreak()).not.toThrow();
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('keeps the streak when the viewer landed on the episode we auto-played into', () => {
        recordAutoplayedEpisode('series-1', 'ep-2');
        recordAutoplayedEpisode('series-1', 'ep-3');

        noteEpisodeArrival('ep-3');

        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });

    it('drops the streak when the viewer picked an episode themselves', () => {
        recordAutoplayedEpisode('series-1', 'ep-2');
        recordAutoplayedEpisode('series-1', 'ep-3');

        // Chosen from a browse page, where the player — and so the activity
        // listener — is not mounted at all.
        noteEpisodeArrival('ep-9');

        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('survives an arrival with no streak to check', () => {
        expect(() => noteEpisodeArrival('ep-1')).not.toThrow();
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it('ignores a corrupted stored streak instead of prompting on it', () => {
        values.set('lumastra:still-watching-streak', 'not json');
        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });
});

describe('viewer activity tracking', () => {
    const values = new Map<string, string>();
    let removals = 0;

    function makeTarget() {
        const listeners = new Map<string, Set<EventListener>>();
        return {
            listeners,
            addEventListener(type: string, fn: EventListener) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type)!.add(fn);
            },
            removeEventListener(type: string, fn: EventListener) {
                listeners.get(type)?.delete(fn);
            },
            fire(type: string) {
                for (const fn of listeners.get(type) ?? []) fn(new Event(type));
            },
        };
    }

    beforeEach(() => {
        values.clear();
        removals = 0;
        vi.stubGlobal('sessionStorage', {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => {
                removals++;
                values.delete(key);
            },
        });
    });

    it('clears the streak when the viewer moves the mouse', () => {
        const target = makeTarget();
        startViewerActivityTracking(target as unknown as EventTarget);
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');

        target.fire('pointermove');

        expect(shouldPromptStillWatching('series-1')).toBe(false);
    });

    it.each(['pointerdown', 'keydown', 'wheel', 'touchstart'])(
        'treats %s as the viewer being awake',
        (eventType) => {
            const target = makeTarget();
            startViewerActivityTracking(target as unknown as EventTarget);
            recordAutoplayedEpisode('series-1', 'ep-x');
            recordAutoplayedEpisode('series-1', 'ep-x');

            target.fire(eventType);

            expect(shouldPromptStillWatching('series-1')).toBe(false);
        },
    );

    it('does not write to storage on every pointer sample', () => {
        let clock = 0;
        const target = makeTarget();
        startViewerActivityTracking(target as unknown as EventTarget, () => clock);

        target.fire('pointermove');
        target.fire('pointermove');
        target.fire('pointermove');
        expect(removals).toBe(1);

        clock += 1000;
        target.fire('pointermove');
        expect(removals).toBe(2);
    });

    it('stops listening once the player is torn down', () => {
        const target = makeTarget();
        const stop = startViewerActivityTracking(target as unknown as EventTarget);
        stop();
        recordAutoplayedEpisode('series-1', 'ep-x');
        recordAutoplayedEpisode('series-1', 'ep-x');

        target.fire('pointermove');

        expect(shouldPromptStillWatching('series-1')).toBe(true);
    });
});
