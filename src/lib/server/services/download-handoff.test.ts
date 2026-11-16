// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const coord = vi.hoisted(() => ({
    store: new Map<string, string>(),
    broken: false,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => ({
        customCommand: async (cmd: string[]) => {
            if (coord.broken) throw new Error('down');
            if (cmd[0] === 'SET') coord.store.set(cmd[1]!, cmd[2]!);
            if (cmd[0] === 'EXISTS') return coord.store.has(cmd[1]!) ? 1 : 0;
            return 'OK';
        },
    }),
}));

import {
    handoffSeen,
    noteHandoff,
    parseHandoffNonce,
    resetHandoffsForTests,
} from './download-handoff';

beforeEach(() => {
    resetHandoffsForTests();
    coord.store.clear();
    coord.broken = false;
});

describe('download hand-off nonces', () => {
    it('is seen only for the user and nonce that were noted', async () => {
        await noteHandoff('u1', 'nonce-aaaa1111');
        expect(await handoffSeen('u1', 'nonce-aaaa1111')).toBe(true);
        expect(await handoffSeen('u2', 'nonce-aaaa1111')).toBe(false);
        expect(await handoffSeen('u1', 'nonce-bbbb2222')).toBe(false);
    });

    it('another replica sees it through Valkey', async () => {
        await noteHandoff('u1', 'nonce-aaaa1111');
        resetHandoffsForTests(); // a different process
        expect(await handoffSeen('u1', 'nonce-aaaa1111')).toBe(true);
    });

    it("a Valkey outage neither throws nor loses this replica's own notes", async () => {
        coord.broken = true;
        await noteHandoff('u1', 'nonce-aaaa1111');
        expect(await handoffSeen('u1', 'nonce-aaaa1111')).toBe(true);
        expect(await handoffSeen('u1', 'nonce-zzzz9999')).toBe(false);
    });

    it('only well-formed nonces are accepted', () => {
        expect(parseHandoffNonce('abcdEFGH_-12')).toBe('abcdEFGH_-12');
        for (const bad of [null, '', 'short', 'has space!!', 'x'.repeat(65), '../etc/passwd']) {
            expect(parseHandoffNonce(bad)).toBeNull();
        }
    });
});
