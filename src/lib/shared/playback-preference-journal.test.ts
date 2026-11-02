// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    advancePreferenceEpoch,
    PlaybackPreferenceJournal,
    LEGACY_PREFERENCE_DIRTY_KEY,
    PREFERENCE_EPOCH_KEY,
    PREFERENCE_PERMIT_KEY,
    PREFERENCE_JOURNAL_PREFIX,
    type PreferenceStorage,
} from './playback-preference-journal';

function storage(): PreferenceStorage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        },
    };
}
const allowed = (field: string): boolean =>
    Object.hasOwn({ audioLanguage: true, subtitleLanguage: true }, field);
function tab(shared: PreferenceStorage, owner: string): PlaybackPreferenceJournal {
    let sequence = 0;
    return new PlaybackPreferenceJournal(
        shared,
        allowed,
        () => `${owner}-${sequence++}`,
        () => 100,
    );
}

describe('tab-owned immutable preference replay', () => {
    it('one tab acknowledgement leaves another tab discarded edits and their actual values durable', () => {
        const shared = storage();
        const a = tab(shared, 'a');
        const b = tab(shared, 'b');
        a.record('subtitleLanguage', 'de', 1);
        const audio = b.record('audioLanguage', 'fr', 1)!;
        b.writeCache('cache', { subtitleLanguage: 'en', audioLanguage: 'fr' });
        b.acknowledge([audio]);
        const fresh = tab(shared, 'fresh');
        expect(fresh.readCache('cache')).toEqual({ subtitleLanguage: 'en', audioLanguage: 'fr' });
        expect(fresh.entries().map(({ field, value }) => ({ field, value }))).toEqual([
            { field: 'subtitleLanguage', value: 'de' },
        ]);
    });
    it('acknowledges captured same-field losers but preserves a concurrent edit during adopted replay', () => {
        const shared = storage();
        const a = tab(shared, 'a');
        const b = tab(shared, 'b');
        a.record('subtitleLanguage', 'en', 1);
        b.record('subtitleLanguage', 'de', 1);
        const replay = tab(shared, 'replay');
        const captured = replay.entries();
        expect(captured.at(-1)?.value).toBe('de');
        a.record('subtitleLanguage', 'ja', 2);
        replay.acknowledge(captured);
        expect(
            tab(shared, 'fresh')
                .entries()
                .map((edit) => edit.value),
        ).toEqual(['ja']);
    });
    it('rotates an account signal without a cache, rejects old snapshots and cannot acknowledge a new-account edit', () => {
        const shared = storage();
        const a = tab(shared, 'a');
        a.writeCache('cache', { audioLanguage: 'de' });
        const oldCache = shared.getItem('cache');
        const old = a.record('audioLanguage', 'de', 1)!;
        shared.removeItem('cache');
        const previousSignal = shared.getItem(PREFERENCE_EPOCH_KEY);
        advancePreferenceEpoch(shared);
        expect(shared.getItem(PREFERENCE_EPOCH_KEY)).not.toBe(previousSignal);
        expect(a.isCurrent()).toBe(false);
        expect(a.record('audioLanguage', 'de', 2)).toBeUndefined();
        const next = tab(shared, 'next');
        expect(next.cleared).toBe(true);
        expect(next.decodeCache(oldCache)).toBeUndefined();
        const current = next.record('audioLanguage', 'it', 1)!;
        a.acknowledge([current, old]);
        expect(next.entries().map((edit) => edit.value)).toEqual(['it']);
    });
    it('honors a newly readable cleanup epoch after an earlier journal write failed', () => {
        const shared = storage();
        const underlying = shared.setItem;
        let fail = false;
        shared.setItem = (key, value) => {
            if (fail && key.startsWith(PREFERENCE_JOURNAL_PREFIX)) throw new Error('Quota');
            underlying(key, value);
        };
        const a = tab(shared, 'a');
        fail = true;
        expect(a.record('audioLanguage', 'de', 1)).toBeUndefined();
        advancePreferenceEpoch(shared);
        expect(a.isCurrent()).toBe(false);
        expect(a.record('audioLanguage', 'de', 2)).toBeUndefined();
    });
    it('retains the only durable legacy copy when migration cannot persist its replacement', () => {
        const shared = storage();
        shared.setItem('cache', JSON.stringify({ subtitleLanguage: 'de' }));
        shared.setItem(LEGACY_PREFERENCE_DIRTY_KEY, '{"subtitleLanguage":1}');
        const a = tab(shared, 'a');
        const underlying = shared.setItem;
        shared.setItem = (key, value) => {
            if (key.startsWith(PREFERENCE_JOURNAL_PREFIX)) throw new Error('Quota');
            underlying(key, value);
        };
        a.migrateLegacy('cache');
        expect(shared.getItem(LEGACY_PREFERENCE_DIRTY_KEY)).toBe('{"subtitleLanguage":1}');
        shared.setItem = underlying;
        tab(shared, 'retry').migrateLegacy('cache');
        expect(shared.getItem(LEGACY_PREFERENCE_DIRTY_KEY)).toBeNull();
        expect(
            tab(shared, 'fresh')
                .entries()
                .map((edit) => edit.value),
        ).toEqual(['de']);
    });
    it('migrates only explicit compatible legacy values and rejects inherited field names', () => {
        const shared = storage();
        shared.setItem('cache', JSON.stringify({ subtitleLanguage: 'de' }));
        shared.setItem(
            LEGACY_PREFERENCE_DIRTY_KEY,
            '{"subtitleLanguage":1,"audioLanguage":2,"constructor":3,"__proto__":4}',
        );
        const journal = tab(shared, 'a');
        journal.migrateLegacy('cache');
        expect(journal.entries().map(({ field, value }) => ({ field, value }))).toEqual([
            { field: 'subtitleLanguage', value: 'de' },
        ]);
        expect(shared.getItem(LEGACY_PREFERENCE_DIRTY_KEY)).toBeNull();
        advancePreferenceEpoch(shared);
        shared.setItem(LEGACY_PREFERENCE_DIRTY_KEY, '{"subtitleLanguage":1}');
        const next = tab(shared, 'b');
        next.migrateLegacy('cache');
        expect(next.entries()).toEqual([]);
    });
});

it('simultaneous first allocations converge and generations advance with fixed storage width', () => {
    const shared = storage();
    const put = shared.setItem;
    let nested: PlaybackPreferenceJournal | undefined;
    shared.setItem = (key, value) => {
        if (key === PREFERENCE_EPOCH_KEY && !nested) {
            shared.setItem = put;
            nested = tab(shared, 'second');
        }
        put(key, value);
    };
    const first = tab(shared, 'first');
    expect(first.epoch).toBe(nested!.epoch);
    expect(first.generation).toBe(nested!.generation);
    expect(first.isCurrent()).toBe(true);
    const before = shared.getItem(PREFERENCE_EPOCH_KEY)!;
    advancePreferenceEpoch(shared);
    const after = shared.getItem(PREFERENCE_EPOCH_KEY)!;
    expect(after.length).toBeLessThanOrEqual(before.length);
    expect(tab(shared, 'next').generation).toBeGreaterThan(first.generation);
});

it('initial quota recovery retains explicit legacy edits and local volume while reclaiming redundant snapshots', () => {
    const shared = storage();
    shared.setItem(
        'playerPreferences',
        JSON.stringify({
            subtitleLanguage: 'de',
            audioLanguage: 'fr',
            volume: 0.42,
            isMuted: true,
            redundant: 'x'.repeat(2000),
        }),
    );
    shared.setItem(LEGACY_PREFERENCE_DIRTY_KEY, '{"subtitleLanguage":3}');
    shared.setItem('dashboard-cache', 'x'.repeat(2000));
    const put = shared.setItem;
    let failures = 0;
    shared.setItem = (key, value) => {
        if (key === PREFERENCE_EPOCH_KEY && shared.getItem('dashboard-cache')) {
            failures++;
            throw new Error('Quota');
        }
        put(key, value);
    };
    const journal = tab(shared, 'first');
    expect(failures).toBe(1);
    expect(journal.isCurrent()).toBe(true);
    expect(journal.readCache('playerPreferences')).toEqual({
        subtitleLanguage: 'de',
        volume: 0.42,
        isMuted: true,
    });
    expect(shared.getItem(LEGACY_PREFERENCE_DIRTY_KEY)).not.toBeNull();
    journal.migrateLegacy('playerPreferences');
    expect(journal.entries().map((edit) => edit.value)).toEqual(['de']);
});

it('compact retirement cannot resurrect the initial identity while full marker allocation is unavailable', async () => {
    const { retirePreferenceEpoch } = await import('./playback-preference-journal');
    const shared = storage();
    const old = tab(shared, 'old');
    const put = shared.setItem;
    shared.setItem = (key, value) => {
        if (key === PREFERENCE_EPOCH_KEY && value.startsWith('{')) throw new Error('Quota');
        put(key, value);
    };
    retirePreferenceEpoch(shared);
    expect(old.isCurrent()).toBe(false);
    const blocked = tab(shared, 'blocked');
    expect(blocked.isCurrent()).toBe(false);
    expect(blocked.epoch).not.toBe(old.epoch);
    shared.setItem = put;
    blocked.bootstrap();
    expect(blocked.isCurrent()).toBe(true);
    expect(blocked.generation).toBeGreaterThan(old.generation);
    expect(blocked.cleared).toBe(true);
});

it('legacy metadata acquires its verified permit without losing scoped cache and replay values', () => {
    const shared = storage();
    shared.setItem(PREFERENCE_EPOCH_KEY, JSON.stringify({ id: 'legacy-epoch', cleared: false }));
    shared.setItem(
        'playerPreferences',
        JSON.stringify({ subtitleLanguage: 'de', __lumastraPreferenceEpoch: 'legacy-epoch' }),
    );
    shared.setItem(LEGACY_PREFERENCE_DIRTY_KEY, '{"subtitleLanguage":2}');
    const journal = tab(shared, 'upgrade');
    expect(journal.isCurrent()).toBe(true);
    expect(journal.epoch).toBe('legacy-epoch');
    expect(shared.getItem(PREFERENCE_PERMIT_KEY)).toBe('1');
    journal.migrateLegacy('playerPreferences');
    expect(journal.entries().map((entry) => entry.value)).toEqual(['de']);
});

it('missing permits retire current markers and recovery stores a fresh higher generation before the grant', () => {
    const shared = storage();
    const old = tab(shared, 'old');
    const generation = old.generation;
    shared.removeItem(PREFERENCE_PERMIT_KEY);
    expect(old.isCurrent()).toBe(false);
    const put = shared.setItem;
    const writes: string[] = [];
    shared.setItem = (key, value) => {
        writes.push(key);
        put(key, value);
    };
    const recovered = tab(shared, 'recovered');
    expect(writes).toEqual([]);
    recovered.bootstrap();
    expect(writes.slice(0, 2)).toEqual([PREFERENCE_EPOCH_KEY, PREFERENCE_PERMIT_KEY]);
    expect(recovered.isCurrent()).toBe(true);
    expect(recovered.epoch).not.toBe(old.epoch);
    expect(recovered.generation).toBeGreaterThan(generation);
    expect(old.isCurrent()).toBe(false);
});
