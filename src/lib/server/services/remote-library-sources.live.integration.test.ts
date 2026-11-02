// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `RemoteLibrarySource.listLibraries()` against a LIVE AudiobookShelf server.
 *
 * Skipped unless `AUDIOURL` and `AUDIOAPIKEY` are set.
 *
 * This exists because the picker's whole value is that the names it shows are
 * the operator's REAL library names, and the only thing that can prove the wire
 * shape carries them is the wire. `AudiobookshelfClient.getLibraries()` returns
 * `[]` on every failure mode, so a picker built on it would render "no
 * libraries" for a down server — the distinction under test here.
 *
 * Run: AUDIOURL=… AUDIOAPIKEY=… npm run test:integration \
 *   src/lib/server/services/remote-library-sources.live.integration.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BASE_URL = process.env.AUDIOURL ?? '';
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const LIVE = Boolean(BASE_URL && API_KEY);

const suite = LIVE ? describe : describe.skip;

/**
 * `remote-library-sources` reads credentials off `config` at CALL time, so the
 * config module is mocked rather than the environment — the module under test
 * imports `config` directly and would otherwise need a real settings store.
 */
const configMock = { AUDIOURL: BASE_URL, AUDIOAPIKEY: API_KEY };
vi.mock('$lib/server/config.js', () => ({
    get config() {
        return configMock;
    },
}));

suite('AudiobookShelf remote library source (live)', () => {
    beforeEach(() => {
        configMock.AUDIOURL = BASE_URL;
        configMock.AUDIOAPIKEY = API_KEY;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function source() {
        const mod = await import('./remote-library-sources.js');
        const s = mod.getRemoteLibrarySource('audiobookshelf');
        if (!s) throw new Error('audiobookshelf source not registered');
        return s;
    }

    it('lists the real libraries by name', async () => {
        const listing = await (await source()).listLibraries();

        expect(listing.status).toBe('ok');
        if (listing.status !== 'ok') return;

        // Not a fixed count — another operator's server has different libraries.
        // What must hold is that every entry carries a usable id AND a non-empty
        // human name, because the picker renders the name and submits the id.
        expect(listing.libraries.length).toBeGreaterThan(0);
        for (const lib of listing.libraries) {
            expect(lib.id).toMatch(/\S/);
            expect(lib.name).toMatch(/\S/);
            expect(lib.kind).toMatch(/\S/);
        }

        // Names must arrive verbatim, including non-ASCII. A picker that shows
        // mojibake for "Hörbücher" is not usable by the operator who named it.
        const names = listing.libraries.map((l) => l.name);
        expect(names.join('|')).not.toContain('�');
    });

    it('derives an abs:// sentinel that survives normalizeLibraryPath', async () => {
        const s = await source();
        const listing = await s.listLibraries();
        if (listing.status !== 'ok') throw new Error(`listing not ok: ${listing.status}`);

        const { normalizeLibraryPath } =
            await import('../database/queries/library-paths.queries.js');

        // The whole point of the sentinel exemption. Before it, every id here
        // round-tripped to `abs:/<id>` and matched no existing row.
        for (const lib of listing.libraries) {
            const path = s.pathFor(lib.id);
            expect(path).toBe(`abs://${lib.id}`);
            expect(normalizeLibraryPath(path)).toBe(path);
        }
    });

    it('reports not_configured — not an empty list — when the key is missing', async () => {
        configMock.AUDIOAPIKEY = '';
        const listing = await (await source()).listLibraries();

        expect(listing.status).toBe('not_configured');
        if (listing.status !== 'not_configured') return;
        expect(listing.missingKeys).toEqual(['AUDIOAPIKEY']);
    });

    it('reports unreachable — not an empty list — when the server does not resolve', async () => {
        configMock.AUDIOURL = 'https://audiobookshelf.invalid';
        const listing = await (await source()).listLibraries();

        expect(listing.status).toBe('unreachable');
        if (listing.status !== 'unreachable') return;
        expect(listing.message).toMatch(/could not reach/i);
    });

    it('reports unreachable with a key-specific message on a rejected key', async () => {
        configMock.AUDIOAPIKEY = 'definitely-not-a-valid-api-key';
        const listing = await (await source()).listLibraries();

        // A wrong-but-present key is the failure an operator is most likely to
        // hit and least likely to diagnose from "no libraries found".
        expect(listing.status).toBe('unreachable');
        if (listing.status !== 'unreachable') return;
        expect(listing.message).toMatch(/api key/i);
    });
});
