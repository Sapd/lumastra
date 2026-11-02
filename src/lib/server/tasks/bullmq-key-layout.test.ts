// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BullMQ internal-key-layout guard.
 *
 * Several task-system safety mechanisms reach directly into BullMQ-internal
 * keys via hand-written Lua / customCommand, under a caret dependency range:
 *
 *   - hard-kill.ts        — LREM :active/:waiting (LISTs), ZREM the ZSETs
 *   - orphan-sweep.ts     — SMEMBERS :dependencies (a SET)
 *   - lua/aging-sweep.lua — prioritized-ZSET score = priority * 2^32
 *
 * All three were silently broken once already because they assumed the wrong
 * key TYPE / priority encoding for the installed BullMQ. This test asserts the
 * assumptions against the ACTUAL installed bullmq Lua so a transitive minor/
 * patch bump that changes the layout fails loudly here — instead of silently
 * turning hard-kill, orphan recovery, and starvation promotion into no-ops.
 *
 * If this test fails after a bullmq upgrade: re-verify the key types in
 * node_modules/bullmq/dist/cjs/commands/*.lua and update the three call sites
 * (and this test) together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function bullmqCommandsDir(): string {
    const pkgJson = require.resolve('bullmq/package.json');
    return pkgJson.replace(/package\.json$/, 'dist/cjs/commands');
}

function readAllCommandLua(): string {
    const dir = bullmqCommandsDir();
    let all = '';
    for (const f of readdirSync(dir)) {
        if (f.endsWith('.lua')) all += readFileSync(`${dir}/${f}`, 'utf8') + '\n';
    }
    // includes/ holds shared snippets like getPriorityScore / addJobInTargetList.
    try {
        const inc = `${dir}/includes`;
        for (const f of readdirSync(inc)) {
            if (f.endsWith('.lua')) all += readFileSync(`${inc}/${f}`, 'utf8') + '\n';
        }
    } catch {
        // includes/ may not exist in some builds — the top-level files suffice.
    }
    return all;
}

describe('BullMQ internal key-layout assumptions (guard for hand-written Lua)', () => {
    const lua = readAllCommandLua();

    it(':active is a LIST (hard-kill must LREM, not ZREM)', () => {
        // BullMQ moves jobs into active via RPOPLPUSH and removes via LREM.
        expect(lua).toMatch(/RPOPLPUSH[^\n]*active|LREM[^\n]*active/i);
        // It must NOT be a sorted set.
        expect(lua).not.toMatch(/ZADD[^\n]*['"]?active['"]?\s*,/i);
    });

    it(':dependencies is a SET (orphan-sweep must SMEMBERS, not ZRANGE)', () => {
        expect(lua).toMatch(/SADD[^\n]*[Dd]ependencies/);
        expect(lua).not.toMatch(/ZADD[^\n]*[Dd]ependencies/);
    });

    it('prioritized-ZSET score uses the 2^32 (0x100000000) priority step', () => {
        // aging-sweep.lua subtracts exactly this to bump one priority level.
        expect(lua).toMatch(/0x100000000|4294967296/);
        // Guard against the old wrong assumption sneaking back.
        expect(lua).not.toMatch(/549755813888/); // 2^39
    });
});
