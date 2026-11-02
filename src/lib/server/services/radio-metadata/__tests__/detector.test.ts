// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { detectFields } from '../detector';

// Repo is "type": "module" — derive dirname from import.meta.url
const HERE = dirname(fileURLToPath(import.meta.url));

function fixture(name: string): unknown {
    const path = join(HERE, 'fixtures', `${name}.json`);
    return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('detectFields', () => {
    it('picks title/artist from TechnoBase.fm playhistory', () => {
        const result = detectFields(fixture('technobase'));
        expect(result.jsonPaths.title).toBe('$.playhistory[0].songtitle');
        expect(result.jsonPaths.artist).toBe('$.playhistory[0].artist');
        expect(result.confidence.title).toBeGreaterThanOrEqual(0.7);
    });

    it('picks DJ name + avatar from TechnoBase.fm', () => {
        const result = detectFields(fixture('technobase'));
        expect(result.jsonPaths.djName).toBe('$.currentdj.name');
        expect(result.jsonPaths.djImageUrl).toBe('$.currentdj.avatar');
    });

    it('picks show fields', () => {
        const result = detectFields(fixture('technobase'));
        expect(result.jsonPaths.showName).toBe('$.currentshow.name');
        expect(result.jsonPaths.showDescription).toBe('$.currentshow.description');
        expect(result.jsonPaths.showImageUrl).toBe('$.currentshow.image');
        expect(result.jsonPaths.showStartsAt).toBe('$.currentshow.starts');
        expect(result.jsonPaths.showEndsAt).toBe('$.currentshow.ends');
    });

    it('picks up-next title from second playhistory entry', () => {
        const result = detectFields(fixture('technobase'));
        expect(result.jsonPaths.upNextTitle).toBeDefined();
    });

    it('returns no mapping when no keys match', () => {
        const result = detectFields({ foo: { bar: 'baz' } });
        expect(result.jsonPaths.title).toBeUndefined();
        expect(result.allLeafPaths).toContain('$.foo.bar');
    });

    it('enumerates all leaf paths', () => {
        const result = detectFields({ a: { b: 1, c: [{ d: 2 }] } });
        expect(result.allLeafPaths).toEqual(expect.arrayContaining(['$.a.b', '$.a.c[0].d']));
    });
});

describe('detectFields (AzuraCast)', () => {
    it('picks title + artist + duration', () => {
        const r = detectFields(fixture('azuracast'));
        expect(r.jsonPaths.title).toBe('$.now_playing.song.title');
        expect(r.jsonPaths.artist).toBe('$.now_playing.song.artist');
        expect(r.jsonPaths.trackDurationSeconds).toBe('$.now_playing.song.duration');
    });

    it('picks up-next from playing_next', () => {
        const r = detectFields(fixture('azuracast'));
        expect(r.jsonPaths.upNextTitle).toBe('$.playing_next.song.title');
        expect(r.jsonPaths.upNextArtist).toBe('$.playing_next.song.artist');
    });
});

describe('detectFields (Icecast-KH)', () => {
    it('picks title + artist from icestats.source', () => {
        const r = detectFields(fixture('icecast-kh'));
        expect(r.jsonPaths.artist).toBe('$.icestats.source.artist');
        expect(r.jsonPaths.title).toBeDefined();
    });
});

// Real Technobase response: data.liveBroadcast.{nickName, showName, image}.
// The parent path is `liveBroadcast` — not in the dj/show keyword sets — so
// detection has to rely on strong leaf-key signals (`nickName`, `showName`).
describe('detectFields (Technobase liveBroadcast)', () => {
    it('picks title + artist from data.{title,artist}', () => {
        const r = detectFields(fixture('technobase-livebroadcast'));
        expect(r.jsonPaths.title).toBe('$.data.title');
        expect(r.jsonPaths.artist).toBe('$.data.artist');
    });

    it('picks djName from liveBroadcast.nickName via strong leaf signal', () => {
        const r = detectFields(fixture('technobase-livebroadcast'));
        expect(r.jsonPaths.djName).toBe('$.data.liveBroadcast.nickName');
        expect(r.confidence.djName).toBeGreaterThanOrEqual(0.9);
    });

    it('picks showName from liveBroadcast.showName via strong leaf signal', () => {
        const r = detectFields(fixture('technobase-livebroadcast'));
        expect(r.jsonPaths.showName).toBe('$.data.liveBroadcast.showName');
        expect(r.confidence.showName).toBeGreaterThanOrEqual(0.9);
    });

    it('does not falsely map djName to showName leaf or vice versa', () => {
        const r = detectFields(fixture('technobase-livebroadcast'));
        expect(r.jsonPaths.djName).not.toBe('$.data.liveBroadcast.showName');
        expect(r.jsonPaths.showName).not.toBe('$.data.liveBroadcast.nickName');
    });

    it('does not auto-map HTML-wrapped image to djImageUrl/showImageUrl', () => {
        // The `image` field is `<img src="..." />` HTML, not a URL —
        // value-shape guard should keep both image rules at 0.
        const r = detectFields(fixture('technobase-livebroadcast'));
        expect(r.jsonPaths.djImageUrl).toBeUndefined();
        expect(r.jsonPaths.showImageUrl).toBeUndefined();
    });
});
