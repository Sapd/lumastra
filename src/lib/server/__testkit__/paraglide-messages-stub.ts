// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test stand-in for `$lib/paraglide/messages` (and `messages.js` — both
 * resolve to the same module id, so one `vi.mock` covers both specifiers).
 *
 * The compiled message barrel re-exports ~9.8k keys (one module per message in
 * the `paraglide:compile` layout CI uses). Loading it through vitest's module
 * runner costs ~35 s cold, so a route test that does `await import('./+server')`
 * inside `it()` — most routes reach the barrel via `ApiResponses` — blows the
 * 30 s test timeout whenever it is the first file in its worker (always, when
 * run alone).
 *
 * Every message key resolves to a function that echoes the key and its inputs,
 * so the stub never goes stale as messages are added. The `m` namespace export
 * (`import { m } from '$lib/paraglide/messages.js'`) resolves to the stub itself.
 * Not enumerable: spreading it yields `{}`. Usage:
 *
 *   vi.mock('$lib/paraglide/messages', async () => {
 *       const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
 *       return messagesStub;
 *   });
 */

type MessageFn = (inputs?: Record<string, unknown>) => string;

function formatInputs(inputs: Record<string, unknown>): string {
    return Object.entries(inputs)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',');
}

function isMessageKey(key: string | symbol): key is string {
    // `then` must stay absent or vitest awaits the mock as a thenable.
    return typeof key === 'string' && key !== 'then' && key !== '__esModule';
}

export const messagesStub: Record<string, MessageFn> = new Proxy({} as Record<string, MessageFn>, {
    get(_target, key) {
        if (!isMessageKey(key)) return undefined;
        if (key === 'm') return messagesStub;
        return (inputs?: Record<string, unknown>) =>
            inputs && Object.keys(inputs).length > 0 ? `${key}(${formatInputs(inputs)})` : key;
    },
    has(_target, key) {
        return isMessageKey(key);
    },
});
