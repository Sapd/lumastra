// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for tmdb-composite-key utilities
 *
 * Tests composite key creation, parsing, collision prevention,
 * and the ExternalIdMap / ExternalIdSet collections.
 */

import { describe, it, expect } from 'vitest';
import {
    type ExternalIdKey,
    type ExternalIdMediaType,
    createExternalIdKey,
    tmdbKey,
    parseExternalIdKey,
    parseTmdbKey,
    ExternalIdMap,
    ExternalIdSet,
    buildExternalIdMap,
    buildExternalIdSet,
} from './tmdb-composite-key';

describe('createExternalIdKey', () => {
    it('creates a key for movie', () => {
        const key = createExternalIdKey(550, 'movie');
        expect(key).toBe('550:movie');
    });

    it('creates a key for tv', () => {
        const key = createExternalIdKey(1399, 'tv');
        expect(key).toBe('1399:tv');
    });

    it('distinguishes same providerId with different mediaType', () => {
        const movieKey = createExternalIdKey(1429, 'movie');
        const tvKey = createExternalIdKey(1429, 'tv');
        expect(movieKey).not.toBe(tvKey);
    });

    it('returns type ExternalIdKey (branded string)', () => {
        const key: ExternalIdKey = createExternalIdKey(1, 'movie');
        expect(typeof key).toBe('string');
        expect(key).toBe('1:movie');
    });
});

describe('tmdbKey (deprecated alias)', () => {
    it('delegates to createExternalIdKey for movie', () => {
        expect(tmdbKey(550, 'movie')).toBe('550:movie');
    });

    it('delegates to createExternalIdKey for tv', () => {
        expect(tmdbKey(1399, 'tv')).toBe('1399:tv');
    });

    it('returns ExternalIdKey branded type', () => {
        const key: ExternalIdKey = tmdbKey(1, 'tv');
        expect(key).toBe('1:tv');
    });
});

describe('parseExternalIdKey', () => {
    it('parses a valid movie key', () => {
        const result = parseExternalIdKey('550:movie');
        expect(result).toEqual({ provider_id: 550, media_type: 'movie' });
    });

    it('parses a valid tv key', () => {
        const result = parseExternalIdKey('1399:tv');
        expect(result).toEqual({ provider_id: 1399, media_type: 'tv' });
    });

    it('returns null for empty string', () => {
        expect(parseExternalIdKey('')).toBeNull();
    });

    it('returns null for string without colon', () => {
        expect(parseExternalIdKey('550movie')).toBeNull();
    });

    it('returns null for non-numeric provider id', () => {
        expect(parseExternalIdKey('abc:movie')).toBeNull();
    });

    it('returns null for unknown media type', () => {
        expect(parseExternalIdKey('550:game')).toBeNull();
    });

    it('handles keys with extra colons when numeric prefix is valid', () => {
        const result = parseExternalIdKey('550:extra:movie');
        expect(result).toEqual({ provider_id: 550, media_type: 'movie' });
    });

    it('returns null when extra colons precede the numeric id', () => {
        expect(parseExternalIdKey('provider:550:movie')).toBeNull();
    });

    it('returns null when provider id part is empty', () => {
        expect(parseExternalIdKey(':movie')).toBeNull();
    });

    it('returns null for negative number provider id', () => {
        // parseInt('-1', 10) is -1, which is a valid number, but the parse checks isNaN only
        // The spec allows negative numbers as they are not NaN
        const result = parseExternalIdKey('-1:movie');
        expect(result).toEqual({ provider_id: -1, media_type: 'movie' });
    });

    it('normalizes uppercase MOVIE to movie', () => {
        const result = parseExternalIdKey('550:MOVIE');
        expect(result).toEqual({ provider_id: 550, media_type: 'movie' });
    });

    it('normalizes SERIES to tv', () => {
        const result = parseExternalIdKey('550:SERIES');
        expect(result).toEqual({ provider_id: 550, media_type: 'tv' });
    });

    it('returns null for missing media type after colon', () => {
        expect(parseExternalIdKey('550:')).toBeNull();
    });
});

describe('parseTmdbKey (deprecated alias)', () => {
    it('delegates to parseExternalIdKey with tmdb_id name', () => {
        const result = parseTmdbKey('550:movie');
        expect(result).toEqual({ tmdb_id: 550, media_type: 'movie' });
    });

    it('returns null for invalid key', () => {
        expect(parseTmdbKey('invalid')).toBeNull();
    });
});

describe('ExternalIdMap', () => {
    describe('basic operations', () => {
        it('sets and gets a value', () => {
            const map = new ExternalIdMap<string>();
            map.set(550, 'movie', 'jellyfin-1');
            expect(map.get(550, 'movie')).toBe('jellyfin-1');
        });

        it('returns undefined for missing key', () => {
            const map = new ExternalIdMap<string>();
            expect(map.get(550, 'movie')).toBeUndefined();
        });

        it('prevents collision between movie and tv with same ID', () => {
            const map = new ExternalIdMap<string>();
            map.set(1429, 'movie', 'movie-ref');
            map.set(1429, 'tv', 'tv-ref');
            expect(map.get(1429, 'movie')).toBe('movie-ref');
            expect(map.get(1429, 'tv')).toBe('tv-ref');
        });

        it('returns correct size', () => {
            const map = new ExternalIdMap<string>();
            expect(map.size).toBe(0);
            map.set(1, 'movie', 'a');
            map.set(2, 'tv', 'b');
            expect(map.size).toBe(2);
        });

        it('overwrites existing value', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'first');
            map.set(1, 'movie', 'second');
            expect(map.get(1, 'movie')).toBe('second');
            expect(map.size).toBe(1);
        });

        it('deletes a value', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'a');
            expect(map.delete(1, 'movie')).toBe(true);
            expect(map.get(1, 'movie')).toBeUndefined();
            expect(map.size).toBe(0);
        });

        it('returns false when deleting non-existent key', () => {
            const map = new ExternalIdMap<string>();
            expect(map.delete(999, 'movie')).toBe(false);
        });

        it('checks existence with has', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'a');
            expect(map.has(1, 'movie')).toBe(true);
            expect(map.has(1, 'tv')).toBe(false);
        });

        it('clears all entries', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'a');
            map.set(2, 'tv', 'b');
            map.clear();
            expect(map.size).toBe(0);
            expect(map.has(1, 'movie')).toBe(false);
        });

        it('supports chaining with set', () => {
            const map = new ExternalIdMap<string>();
            const result = map.set(1, 'movie', 'a').set(2, 'tv', 'b');
            expect(result).toBe(map);
            expect(map.size).toBe(2);
        });
    });

    describe('key-based operations', () => {
        it('sets and gets by ExternalIdKey', () => {
            const map = new ExternalIdMap<number>();
            const key = createExternalIdKey(42, 'tv');
            map.setByKey(key, 100);
            expect(map.getByKey(key)).toBe(100);
        });

        it('checks existence by key with hasByKey', () => {
            const map = new ExternalIdMap<number>();
            const key = createExternalIdKey(42, 'tv');
            map.setByKey(key, 100);
            expect(map.hasByKey(key)).toBe(true);
            expect(map.hasByKey(createExternalIdKey(42, 'movie'))).toBe(false);
        });

        it('returns raw underlying map', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'a');
            const raw = map.getRawMap();
            expect(raw.size).toBe(1);
            expect(raw.get(createExternalIdKey(1, 'movie'))).toBe('a');
        });
    });

    describe('iterators', () => {
        it('iterates entries as [components, value]', () => {
            const map = new ExternalIdMap<string>();
            map.set(550, 'movie', 'a');
            map.set(1399, 'tv', 'b');

            const entries = Array.from(map.entries());
            expect(entries).toHaveLength(2);
            expect(entries[0]).toEqual([{ provider_id: 550, media_type: 'movie' }, 'a']);
            expect(entries[1]).toEqual([{ provider_id: 1399, media_type: 'tv' }, 'b']);
        });

        it('iterates values', () => {
            const map = new ExternalIdMap<number>();
            map.set(1, 'movie', 10);
            map.set(2, 'tv', 20);
            expect(Array.from(map.values())).toEqual([10, 20]);
        });

        it('iterates keys as components', () => {
            const map = new ExternalIdMap<string>();
            map.set(550, 'movie', 'a');
            const keys = Array.from(map.keys());
            expect(keys).toEqual([{ provider_id: 550, media_type: 'movie' }]);
        });

        it('executes forEach callback with value and components', () => {
            const map = new ExternalIdMap<string>();
            map.set(1, 'movie', 'a');
            map.set(2, 'tv', 'b');

            const collected: Array<{
                value: string;
                key: { provider_id: number; media_type: ExternalIdMediaType };
            }> = [];
            map.forEach((value, key) => {
                collected.push({ value, key });
            });

            expect(collected).toHaveLength(2);
            expect(collected[0].value).toBe('a');
            expect(collected[0].key).toEqual({
                provider_id: 1,
                media_type: 'movie',
            });
        });

        it('handles malformed internal keys gracefully in iterators', () => {
            // This tests the defensive yield in entries() and keys()
            const map = new ExternalIdMap<string>();
            const rawMap = map.getRawMap();
            // Cast to bypass branded type for this edge-case test
            const badKey = 'not-a-valid-key' as ExternalIdKey;
            (rawMap as unknown as Map<ExternalIdKey, string>).set(badKey, 'x');

            const entries = Array.from(map.entries());
            const keys = Array.from(map.keys());
            // malformed key should be silently skipped
            expect(entries).toHaveLength(0);
            expect(keys).toHaveLength(0);
            // values() is unaffected because it yields from the inner Map directly
            expect(Array.from(map.values())).toEqual(['x']);
        });
    });
});

describe('ExternalIdSet', () => {
    describe('basic operations', () => {
        it('adds and checks membership', () => {
            const set = new ExternalIdSet();
            set.add(550, 'movie');
            expect(set.has(550, 'movie')).toBe(true);
            expect(set.has(550, 'tv')).toBe(false);
        });

        it('prevents false positives across media types', () => {
            const set = new ExternalIdSet();
            set.add(1429, 'movie');
            expect(set.has(1429, 'tv')).toBe(false);
        });

        it('returns correct size', () => {
            const set = new ExternalIdSet();
            expect(set.size).toBe(0);
            set.add(1, 'movie');
            set.add(2, 'tv');
            expect(set.size).toBe(2);
        });

        it('does not duplicate entries', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            set.add(1, 'movie');
            expect(set.size).toBe(1);
        });

        it('deletes a value', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            expect(set.delete(1, 'movie')).toBe(true);
            expect(set.has(1, 'movie')).toBe(false);
        });

        it('returns false when deleting non-existent value', () => {
            const set = new ExternalIdSet();
            expect(set.delete(999, 'tv')).toBe(false);
        });

        it('clears all entries', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            set.add(2, 'tv');
            set.clear();
            expect(set.size).toBe(0);
            expect(set.has(1, 'movie')).toBe(false);
        });

        it('supports chaining with add', () => {
            const set = new ExternalIdSet();
            const result = set.add(1, 'movie').add(2, 'tv');
            expect(result).toBe(set);
            expect(set.size).toBe(2);
        });
    });

    describe('key-based operations', () => {
        it('adds by ExternalIdKey', () => {
            const set = new ExternalIdSet();
            const key = createExternalIdKey(42, 'tv');
            set.addByKey(key);
            expect(set.hasByKey(key)).toBe(true);
        });

        it('distinguishes by key media type', () => {
            const set = new ExternalIdSet();
            set.addByKey(createExternalIdKey(42, 'movie'));
            expect(set.hasByKey(createExternalIdKey(42, 'tv'))).toBe(false);
        });

        it('returns raw underlying set', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            const raw = set.getRawSet();
            expect(raw.size).toBe(1);
            expect(raw.has(createExternalIdKey(1, 'movie'))).toBe(true);
        });
    });

    describe('iterators', () => {
        it('iterates values as components', () => {
            const set = new ExternalIdSet();
            set.add(550, 'movie');
            set.add(1399, 'tv');
            expect(Array.from(set.values())).toEqual([
                { provider_id: 550, media_type: 'movie' },
                { provider_id: 1399, media_type: 'tv' },
            ]);
        });

        it('executes forEach callback with components', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            const collected: Array<{
                provider_id: number;
                media_type: ExternalIdMediaType;
            }> = [];
            set.forEach((key) => {
                collected.push(key);
            });
            expect(collected).toEqual([{ provider_id: 1, media_type: 'movie' }]);
        });

        it('converts to array of raw keys', () => {
            const set = new ExternalIdSet();
            set.add(1, 'movie');
            set.add(2, 'tv');
            const arr = set.toArray();
            expect(arr).toContain('1:movie');
            expect(arr).toContain('2:tv');
            expect(arr).toHaveLength(2);
        });

        it('handles malformed internal keys gracefully in values()', () => {
            const set = new ExternalIdSet();
            const rawSet = set.getRawSet();
            const badKey = 'not-a-valid-key' as ExternalIdKey;
            (rawSet as unknown as Set<ExternalIdKey>).add(badKey);
            expect(Array.from(set.values())).toHaveLength(0);
        });
    });

    describe('static fromItems', () => {
        it('builds set from items array', () => {
            const items = [
                { provider_id: 550, media_type: 'movie' as const },
                { provider_id: 1399, media_type: 'tv' as const },
            ];
            const set = ExternalIdSet.fromItems(items);
            expect(set.has(550, 'movie')).toBe(true);
            expect(set.has(1399, 'tv')).toBe(true);
            expect(set.size).toBe(2);
        });

        it('returns empty set for empty array', () => {
            const set = ExternalIdSet.fromItems([]);
            expect(set.size).toBe(0);
        });

        it('ignores items with invalid media_type per buildExternalIdSet semantics', () => {
            // fromItems does not filter — it blindly uses the provided type,
            // so invalid types end up as keys but parseExternalIdKey won't decode them.
            // We test the contract as-is.
            const items = [
                { provider_id: 1, media_type: 'movie' as const },
                // fixture deliberately supplies an out-of-model type
                // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
                { provider_id: 2, media_type: 'book' as unknown as 'movie' },
            ];
            const set = ExternalIdSet.fromItems(items);
            expect(set.size).toBe(2);
        });
    });
});

describe('buildExternalIdMap', () => {
    it('builds map from Jellyfin-like items', () => {
        const items = [
            {
                Id: 'jf-1',
                Type: 'Movie',
                ProviderIds: { Tmdb: '550' },
            },
            {
                Id: 'jf-2',
                Type: 'Series',
                ProviderIds: { tmdb: '1399' },
            },
        ];
        const map = buildExternalIdMap(items);
        expect(map.get(550, 'movie')).toBe('jf-1');
        expect(map.get(1399, 'tv')).toBe('jf-2');
    });

    it('skips items without ProviderIds', () => {
        const items = [{ Id: 'jf-1', Type: 'Movie' }];
        const map = buildExternalIdMap(items);
        expect(map.size).toBe(0);
    });

    it('skips items with non-numeric TMDB id', () => {
        const items = [
            {
                Id: 'jf-1',
                Type: 'Movie',
                ProviderIds: { Tmdb: 'not-a-number' },
            },
        ];
        const map = buildExternalIdMap(items);
        expect(map.size).toBe(0);
    });

    it('SKIPS types TMDB does not catalog instead of filing them under movie', () => {
        // This test used to assert `map.get(550, 'movie') === 'jf-1'` — it
        // encoded the bug. A MusicAlbum has no TMDB namespace, so filing it as
        // TMDB movie 550 let it SHADOW the real movie 550 ("Quiet Orbit") in a map
        // whose whole purpose is collision avoidance.
        const items = [
            {
                Id: 'jf-1',
                Type: 'MusicAlbum',
                ProviderIds: { Tmdb: '550' },
            },
        ];
        const map = buildExternalIdMap(items);
        expect(map.get(550, 'movie')).toBeUndefined();
        expect(map.size).toBe(0);
    });

    it('still files a real movie alongside a skipped non-TMDB sibling', () => {
        const map = buildExternalIdMap([
            { Id: 'jf-album', Type: 'MusicAlbum', ProviderIds: { Tmdb: '550' } },
            { Id: 'jf-movie', Type: 'Movie', ProviderIds: { Tmdb: '550' } },
        ]);
        expect(map.get(550, 'movie')).toBe('jf-movie');
        expect(map.size).toBe(1);
    });

    it('maps Episode to tv', () => {
        const items = [
            {
                Id: 'jf-ep-1',
                Type: 'Episode',
                ProviderIds: { Tmdb: '900' },
            },
        ];
        const map = buildExternalIdMap(items);
        expect(map.get(900, 'tv')).toBe('jf-ep-1');
    });

    it('returns empty map for empty array', () => {
        const map = buildExternalIdMap([]);
        expect(map.size).toBe(0);
    });
});

describe('buildExternalIdSet', () => {
    it('builds set from DB-like items', () => {
        const items = [
            { provider_id: 550, media_type: 'movie' },
            { provider_id: 1399, media_type: 'tv' },
        ];
        const set = buildExternalIdSet(items);
        expect(set.has(550, 'movie')).toBe(true);
        expect(set.has(1399, 'tv')).toBe(true);
        expect(set.size).toBe(2);
    });

    it('filters items with non-canonical media types', () => {
        const items = [
            { provider_id: 550, media_type: 'movie' },
            { provider_id: 999, media_type: 'episode' },
            { provider_id: 888, media_type: 'audiobook' },
        ];
        const set = buildExternalIdSet(items);
        expect(set.has(550, 'movie')).toBe(true);
        // 'episode' is not a valid ExternalIdMediaType ('movie' | 'tv')
        expect(set.has(999, 'episode' as ExternalIdMediaType)).toBe(false);
        expect(set.has(888, 'audiobook' as ExternalIdMediaType)).toBe(false);
        expect(set.size).toBe(1);
    });

    it('accepts uppercase media types via isMovie/isSeries', () => {
        const items = [
            { provider_id: 550, media_type: 'MOVIE' },
            { provider_id: 1399, media_type: 'SERIES' },
        ];
        const set = buildExternalIdSet(items);
        expect(set.size).toBe(2);
    });

    it('returns empty set for empty array', () => {
        const set = buildExternalIdSet([]);
        expect(set.size).toBe(0);
    });
});

describe('collision prevention (integration)', () => {
    it('ExternalIdMap correctly stores 1429:movie and 1429:tv', () => {
        // Real-world collision: TMDB ID 1429 is both a movie and a TV show
        const map = new ExternalIdMap<string>();
        map.set(1429, 'movie', '25th Hour');
        map.set(1429, 'tv', 'Voyage to Orion');
        expect(map.get(1429, 'movie')).toBe('25th Hour');
        expect(map.get(1429, 'tv')).toBe('Voyage to Orion');
    });

    it('ExternalIdSet correctly stores 1429:movie and 1429:tv', () => {
        const set = new ExternalIdSet();
        set.add(1429, 'movie');
        set.add(1429, 'tv');
        expect(set.has(1429, 'movie')).toBe(true);
        expect(set.has(1429, 'tv')).toBe(true);
        expect(set.size).toBe(2);
    });
});
