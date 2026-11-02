// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard against a silent, whole-declaration-killing CSS mistake.
 *
 * `app.css` defines colour tokens TWICE, in two incompatible shapes:
 *   --color-surface-500:     #4f5e8a    (a full colour, for `var(...)` alone)
 *   --color-surface-500-rgb: 79 94 138  (channels, for `rgb(var(...) / alpha)`)
 *
 * Writing `rgb(var(--color-surface-500) / 0.5)` — the non-`-rgb` name inside
 * `rgb()` — substitutes to `rgb(#4f5e8a / 0.5)`, which is not a valid colour,
 * so the browser discards the ENTIRE declaration. There is no console warning
 * and no build error: the rule just silently does nothing.
 *
 * That is how AvatarUploadPopover's drop zone lost its `border: 2px dashed …`
 * outright (Tailwind preflight's `border-width: 0` then won) and both of its
 * hover/drag highlights, leaving a functioning but completely invisible drop
 * target on /settings/account — measured on preprod as `border: 0px none`.
 *
 * Scans source rather than computed style because Svelte's scoped `<style>`
 * blocks never reach the DOM in this harness (see
 * components/player/player-container-stacking.test.ts for that finding).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** `rgb(var(--color-…))` / `rgba(var(--color-…))` where the token is NOT a `-rgb` triplet. */
const BAD_TOKEN = /rgba?\(\s*var\(\s*(--color-[a-z0-9-]*?)\s*\)/gi;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'paraglide') continue;
            walk(full, out);
        } else if (/\.(svelte|css)$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

describe('rgb(var(--color-*)) token syntax', () => {
    it('never passes a non-`-rgb` colour token to rgb()/rgba()', () => {
        const offenders: string[] = [];

        for (const file of walk(SRC)) {
            const text = readFileSync(file, 'utf8');
            const lines = text.split('\n');
            for (const [i, line] of lines.entries()) {
                BAD_TOKEN.lastIndex = 0;
                let match: RegExpExecArray | null;
                while ((match = BAD_TOKEN.exec(line)) !== null) {
                    if (match[1].endsWith('-rgb')) continue;
                    offenders.push(
                        `${relative(process.cwd(), file)}:${i + 1}  ${match[1]} → use ${match[1]}-rgb`,
                    );
                }
            }
        }

        expect(offenders, `Invalid colour tokens inside rgb():\n${offenders.join('\n')}`).toEqual(
            [],
        );
    });
});
