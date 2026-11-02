// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { luaLoader } from './loader.js';
import { type ValkeyLike } from '../valkey-types.js';

/**
 * Characterization test for CROSSSLOT handling in `LuaScriptLoader.invoke()`.
 *
 * Unlike NOSCRIPT (handled: EVALSHA fails → EVAL fallback), a CROSSSLOT error
 * — which a Valkey/Redis Cluster deployment returns when a script's `keys`
 * span more than one hash slot — has NO special handling in `invoke()`. There
 * is no same-slot guard on the `...keys` passed in, and no retry/translation
 * on the error path: it propagates the raw client error straight to the
 * caller. This test documents that gap; it is NOT exercising a fix.
 */
describe('LuaScriptLoader.invoke — CROSSSLOT (cluster multi-key) gap', () => {
    beforeAll(async () => {
        await luaLoader.load();
    });

    function makeCrossSlotClient(): {
        client: ValkeyLike;
        customCommand: ReturnType<typeof vi.fn>;
    } {
        const crossSlotError = new Error("CROSSSLOT Keys in request don't hash to the same slot");
        const customCommand = vi.fn().mockRejectedValue(crossSlotError);
        return { client: { customCommand }, customCommand };
    }

    it('propagates the raw CROSSSLOT error to the caller — no retry, no translation', async () => {
        const { client, customCommand } = makeCrossSlotClient();

        await expect(
            luaLoader.invoke(
                'claim-run',
                // Two keys — in a real cluster deployment these could land in
                // different hash slots, which is exactly what trips CROSSSLOT.
                ['task:run:aaaa', 'task:run:bbbb'],
                ['instance-1', 'boot-1', String(Date.now())],
                client,
            ),
        ).rejects.toThrow(/CROSSSLOT/);

        // No fallback/retry attempt: exactly one EVALSHA call, no second
        // (EVAL) call the way isNoScriptError triggers for NOSCRIPT.
        expect(customCommand).toHaveBeenCalledTimes(1);
        expect(customCommand.mock.calls[0][0][0]).toBe('EVALSHA');
    });

    it('does NOT classify CROSSSLOT as a NOSCRIPT condition (so it never reaches the EVAL fallback path)', async () => {
        const { client, customCommand } = makeCrossSlotClient();

        try {
            await luaLoader.invoke('claim-run', ['task:run:aaaa', 'task:run:bbbb'], [], client);
        } catch {
            // expected — asserted above; here we only care about call count.
        }

        // If CROSSSLOT were (mis)treated as NOSCRIPT, invoke() would issue a
        // second call using EVAL. It must not.
        expect(customCommand).toHaveBeenCalledTimes(1);
    });
});
