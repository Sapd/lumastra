// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    carriedIntent,
    intentFromLanding,
    isHintDismissed,
    markHintDismissed,
    readWatchIntent,
    setWatchIntent,
    type WatchIntent,
} from './watch-intent';

const EPISODE: WatchIntent = { kind: 'episode' };
const CONTINUE_A: WatchIntent = { kind: 'continue', seriesId: 'series-a' };

function memoryStorage(): Storage {
    const map = new Map<string, string>();
    return {
        get length() {
            return map.size;
        },
        clear: () => map.clear(),
        getItem: (k) => map.get(k) ?? null,
        key: (i) => [...map.keys()][i] ?? null,
        removeItem: (k) => void map.delete(k),
        setItem: (k, v) => void map.set(k, String(v)),
    };
}

function throwingStorage(): Storage {
    const boom = () => {
        throw new Error('SecurityError');
    };
    return {
        length: 0,
        clear: boom,
        getItem: boom,
        key: boom,
        removeItem: boom,
        setItem: boom,
    };
}

describe('readWatchIntent / setWatchIntent', () => {
    let storage: Storage;
    beforeEach(() => {
        storage = memoryStorage();
        vi.stubGlobal('sessionStorage', storage);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('defaults to the episode intent', () => {
        expect(readWatchIntent()).toEqual(EPISODE);
    });

    it('round-trips a continue intent', () => {
        setWatchIntent(CONTINUE_A);
        expect(readWatchIntent()).toEqual(CONTINUE_A);
        expect(JSON.parse(storage.getItem('watchIntent') ?? 'null')).toEqual(CONTINUE_A);
    });

    it('round-trips back to episode', () => {
        setWatchIntent(CONTINUE_A);
        setWatchIntent(EPISODE);
        expect(readWatchIntent()).toEqual(EPISODE);
    });

    it('treats malformed JSON as episode', () => {
        storage.setItem('watchIntent', '{not json');
        expect(readWatchIntent()).toEqual(EPISODE);
    });

    it('treats a continue intent without a seriesId as episode', () => {
        storage.setItem('watchIntent', JSON.stringify({ kind: 'continue' }));
        expect(readWatchIntent()).toEqual(EPISODE);
    });

    it('treats an unknown kind as episode', () => {
        storage.setItem('watchIntent', JSON.stringify({ kind: 'binge', seriesId: 'x' }));
        expect(readWatchIntent()).toEqual(EPISODE);
    });
});

describe('storage unavailable', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('falls back to episode when sessionStorage throws', () => {
        vi.stubGlobal('sessionStorage', throwingStorage());
        expect(() => setWatchIntent(CONTINUE_A)).not.toThrow();
        expect(readWatchIntent()).toEqual(EPISODE);
        expect(() => markHintDismissed('ep-1')).not.toThrow();
        expect(isHintDismissed('ep-1')).toBe(false);
    });

    it('falls back to episode when sessionStorage is missing (SSR)', () => {
        vi.stubGlobal('sessionStorage', undefined);
        expect(readWatchIntent()).toEqual(EPISODE);
        expect(() => setWatchIntent(CONTINUE_A)).not.toThrow();
        expect(isHintDismissed('ep-1')).toBe(false);
    });
});

describe('intentFromLanding', () => {
    const p = (query: string) => new URLSearchParams(query);

    it.each(['series', 'stay', 'seek', 'finished'])(
        'resolved=%s enters continue for the series',
        (resolved) => {
            expect(intentFromLanding(p(`resolved=${resolved}`), 'series-a', EPISODE)).toEqual(
                CONTINUE_A,
            );
        },
    );

    it('resolved=series without a seriesId stays episode', () => {
        expect(intentFromLanding(p('resolved=series'), null, CONTINUE_A)).toEqual(EPISODE);
    });

    it('an unrelated resolved value (episode-query) does not enter continue', () => {
        expect(intentFromLanding(p('resolved=episode-query'), 'series-a', EPISODE)).toEqual(
            EPISODE,
        );
    });

    it.each(['t=120', 'playlist=4&position=2', 'ctx=educational'])(
        '%s clears the intent to episode',
        (query) => {
            expect(intentFromLanding(p(query), 'series-a', CONTINUE_A)).toEqual(EPISODE);
        },
    );

    it('keeps a continue intent for the same series (autoplay landing)', () => {
        expect(intentFromLanding(p(''), 'series-a', CONTINUE_A)).toEqual(CONTINUE_A);
    });

    it('drops a continue intent for a different series', () => {
        expect(intentFromLanding(p(''), 'series-b', CONTINUE_A)).toEqual(EPISODE);
    });

    it('drops a continue intent on a non-episode landing', () => {
        expect(intentFromLanding(p(''), null, CONTINUE_A)).toEqual(EPISODE);
    });

    it('keeps episode when episode is current', () => {
        expect(intentFromLanding(p(''), 'series-a', EPISODE)).toEqual(EPISODE);
    });
});

describe('carriedIntent', () => {
    it('autoplay carries the stored intent', () => {
        expect(carriedIntent(CONTINUE_A, { autoplay: true, restored: false })).toEqual(CONTINUE_A);
    });

    it('a reload / history restore carries the stored intent', () => {
        expect(carriedIntent(CONTINUE_A, { autoplay: false, restored: true })).toEqual(CONTINUE_A);
    });

    it('any other arrival (picker, episode list, link) starts from episode', () => {
        expect(carriedIntent(CONTINUE_A, { autoplay: false, restored: false })).toEqual(EPISODE);
    });
});

describe('hint dismissal', () => {
    beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()));
    afterEach(() => vi.unstubAllGlobals());

    it('remembers a dismissed episode', () => {
        expect(isHintDismissed('ep-1')).toBe(false);
        markHintDismissed('ep-1');
        expect(isHintDismissed('ep-1')).toBe(true);
        expect(isHintDismissed('ep-2')).toBe(false);
    });

    it('does not duplicate an entry', () => {
        markHintDismissed('ep-1');
        markHintDismissed('ep-1');
        expect(JSON.parse(sessionStorage.getItem('watchMarkerHintDismissed') ?? '[]')).toEqual([
            'ep-1',
        ]);
    });

    it('caps the list at 50, dropping the oldest', () => {
        for (let i = 0; i < 55; i++) markHintDismissed(`ep-${i}`);
        const stored = JSON.parse(sessionStorage.getItem('watchMarkerHintDismissed') ?? '[]');
        expect(stored).toHaveLength(50);
        expect(isHintDismissed('ep-0')).toBe(false);
        expect(isHintDismissed('ep-4')).toBe(false);
        expect(isHintDismissed('ep-5')).toBe(true);
        expect(isHintDismissed('ep-54')).toBe(true);
    });

    it('ignores a malformed stored list', () => {
        sessionStorage.setItem('watchMarkerHintDismissed', '{"a":1}');
        expect(isHintDismissed('ep-1')).toBe(false);
        markHintDismissed('ep-1');
        expect(isHintDismissed('ep-1')).toBe(true);
    });
});
