// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every way into `runAssistant` must go through the same admission helper
 * (per-minute limit + in-flight slot). This scans the source tree for callers
 * so a new entry point cannot be added without deciding how it is admitted.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.svelte-kit' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|js|svelte)$/.test(name) && !/\.test\.[tj]s$/.test(name)) out.push(full);
    }
    return out;
}

const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'plugins'))].map((f) => ({
    path: relative(ROOT, f),
    text: readFileSync(f, 'utf8'),
}));

const callersOf = (re: RegExp): string[] =>
    sources
        .filter((s) => re.test(s.text))
        .map((s) => s.path)
        .sort();

describe('runAssistant entry points', () => {
    it('are exactly the HTTP route and the registry adapter behind the plugin bridge', () => {
        // Direct calls: `runAssistant(` not preceded by `.`/`function`.
        const direct = callersOf(/(?<![\w.])(?<!function )runAssistant\(\s*[\n{]/);
        expect(direct).toEqual([
            'src/lib/server/boot/compat-init.ts',
            'src/routes/api/(modules)/assistant/+server.ts',
        ]);
        const viaRegistry = callersOf(
            /\bmod\.runAssistant\(|getAiAssistantProvider\(\)\??\.runAssistant/,
        );
        expect(viaRegistry).toEqual(['src/lib/server/tasks/plugin-ai-surface.ts']);
    });

    it('HTTP route admits up front and hands runAssistant the ticket', () => {
        const route = sources.find(
            (s) => s.path === 'src/routes/api/(modules)/assistant/+server.ts',
        )!;
        expect(route.text).toContain('admitAssistantRun(');
        for (const call of route.text.split('runAssistant(').slice(1)) {
            expect(call.slice(0, 400)).toContain('admission');
        }
    });

    it('runAssistant admits any caller that arrives without a ticket', () => {
        const svc = sources.find(
            (s) => s.path === 'src/lib/server/assistant/assistant-service.ts',
        )!;
        expect(svc.text).toContain('admitAssistantRun(');
    });
});
