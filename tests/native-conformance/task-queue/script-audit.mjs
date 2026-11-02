// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

export async function publishedCommand(name) {
    const registry = path.join(
        process.env.CARGO_HOME ?? path.join(homedir(), '.cargo'),
        'registry/src',
    );
    for (const candidate of await readdir(registry)) {
        const root = path.join(registry, candidate, 'bullmq-official-1.4.0/src/commands');
        try {
            const file = (await readdir(root)).find(
                (item) => item.startsWith(`${name}-`) && item.endsWith('.lua'),
            );
            if (file) return readFile(path.join(root, file));
        } catch {
            /* another registry namespace */
        }
    }
    throw new Error(`missing exact published Rust command ${name}`);
}

// Remove only comments/whitespace outside Lua string literals. String contents
// remain byte-for-byte significant; this is source parity, not a Lua evaluator.
function canonical(source) {
    let result = '';
    let index = 0;
    const longEnd = (start) => {
        const open = source.slice(start).match(/^\[(=*)\[/);
        if (!open) return undefined;
        const close = `]${open[1]}]`;
        const end = source.indexOf(close, start + open[0].length);
        assert.ok(end >= 0, 'unterminated Lua long literal/comment');
        return end + close.length;
    };
    while (index < source.length) {
        if (source.startsWith('--', index)) {
            index = longEnd(index + 2) ?? (source.indexOf('\n', index) + 1 || source.length);
        } else if (source[index] === '"' || source[index] === "'") {
            const quote = source[index];
            result += source[index++];
            while (index < source.length) {
                const char = source[index++];
                result += char;
                if (char === '\\') result += source[index++];
                else if (char === quote) break;
            }
        } else if (source[index] === '[' && longEnd(index) !== undefined) {
            const end = longEnd(index);
            result += source.slice(index, end);
            index = end;
        } else {
            if (!/\s/.test(source[index])) result += source[index];
            index++;
        }
    }
    return result;
}

test('exact published native/TypeScript critical Lua sources match after include expansion', async () => {
    const registry = path.join(
        process.env.CARGO_HOME ?? path.join(homedir(), '.cargo'),
        'registry/src',
    );
    const candidates = await readdir(registry);
    const roots = [];
    for (const candidate of candidates) {
        const root = path.join(registry, candidate, 'bullmq-official-1.4.0/src/commands');
        try {
            await readdir(root);
            roots.push(root);
        } catch {
            /* another registry namespace */
        }
    }
    assert.ok(roots.length > 0, 'cargo must fetch the exact published crate before qualification');
    const compiled = path.join(
        path.dirname(require.resolve('bullmq/package.json')),
        'dist/cjs/scripts',
    );
    const names = [
        'moveToActive',
        'moveToFinished',
        'moveToDelayed',
        'moveStalledJobsToWait',
        'extendLock',
        'addStandardJob',
        'addPrioritizedJob',
        'addDelayedJob',
        'retryJob',
        'moveToWaitingChildren',
        'addParentJob',
        'removeJob',
    ];
    for (const name of names) {
        const file = (await readdir(compiled)).find(
            (item) => item.startsWith(`${name}-`) && item.endsWith('.js'),
        );
        assert.ok(file, `missing pinned npm command ${name}`);
        const npm = require(path.join(compiled, file))[name].content;
        for (const root of roots) {
            const rust = await readFile(path.join(root, file.replace(/\.js$/, '.lua')), 'utf8');
            assert.equal(
                canonical(rust),
                canonical(npm),
                `${name}: published Lua protocol source drift`,
            );
        }
    }
});
