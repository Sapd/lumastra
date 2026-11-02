// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Logger.
 *
 * Scope: the task-logger tee path and the per-value sanitization it applies
 * via `toPlainRecord`. Critical regression target: a plugin calling
 * `ctx.logger.info('x', circular)` must not produce a buffer entry whose
 * `JSON.stringify` throws downstream — before the sanitizer, one poisoned
 * entry would close every SSE subscriber's stream and trigger an infinite
 * reconnect loop as the entry replayed on each reconnect.
 *
 * Sanitization is tested independently of any buffer implementation by
 * registering an in-memory fixture sink via `registerTaskLogSink` — the
 * same wire `tasks/log-buffer` uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, makeTaskLogger, registerTaskLogSink, type TaskLogTeeEntry } from './logger';

let captured: TaskLogTeeEntry[] = [];

beforeEach(() => {
    captured = [];
    registerTaskLogSink((entry) => {
        captured.push(entry);
    });
});

afterEach(() => {
    registerTaskLogSink(null);
});

function entriesForTask(taskId: string): TaskLogTeeEntry[] {
    return captured.filter((e) => e.taskId === taskId);
}

describe('makeTaskLogger sanitization (W11-P-A #6 — circular-JSON guard)', () => {
    it('replaces circular references with a stable sentinel', () => {
        const base = Logger.for('SanTest');
        const task = makeTaskLogger(base, 'task-circular', 'job-1');

        // Classic self-referencing object — JSON.stringify throws on this.
        interface Circ {
            name: string;
            self?: Circ;
        }
        const circ: Circ = { name: 'ouroboros' };
        circ.self = circ;

        task.info('circular payload', { value: circ });

        const entries = entriesForTask('task-circular');
        expect(entries).toHaveLength(1);
        // Serialization of the buffered entry must succeed — this is the
        // exact call the SSE endpoint makes per frame.
        const serialized = JSON.stringify(entries[0]);
        expect(typeof serialized).toBe('string');
        expect(serialized).toContain('unserializable');
    });

    it('replaces BigInt values with a readable sentinel', () => {
        const base = Logger.for('SanTest');
        const task = makeTaskLogger(base, 'task-bigint', null);

        task.info('bigint payload', { count: 42n });

        const entries = entriesForTask('task-bigint');
        expect(entries).toHaveLength(1);
        const serialized = JSON.stringify(entries[0]);
        expect(typeof serialized).toBe('string');
        // The sentinel preserves the readable count for ops correlation.
        expect(serialized).toContain('42');
        expect(serialized).toContain('unserializable');
    });

    it('isolates unserializable values field-by-field (one bad key does not nuke siblings)', () => {
        const base = Logger.for('SanTest');
        const task = makeTaskLogger(base, 'task-mixed', null);

        interface Circ {
            self?: Circ;
        }
        const circ: Circ = {};
        circ.self = circ;

        task.info('mixed payload', { ok: 'plain', bad: circ });

        const entries = entriesForTask('task-mixed');
        expect(entries).toHaveLength(1);
        expect(entries[0].data).toBeDefined();
        const data = entries[0].data as Record<string, unknown>;
        expect(data.ok).toBe('plain');
        expect(typeof data.bad).toBe('string');
        expect(data.bad as string).toContain('unserializable');

        // And the whole entry is JSON-round-trippable.
        expect(() => JSON.stringify(entries[0])).not.toThrow();
    });

    it('survives a getter that throws', () => {
        const base = Logger.for('SanTest');
        const task = makeTaskLogger(base, 'task-throws', null);

        // Host-object-like shape: property access throws during
        // JSON.stringify traversal.
        const throwy: Record<string, unknown> = {};
        Object.defineProperty(throwy, 'kaboom', {
            enumerable: true,
            get() {
                throw new Error('no peeking');
            },
        });

        task.info('throws payload', { bad: throwy });

        const entries = entriesForTask('task-throws');
        expect(entries).toHaveLength(1);
        // Stringify must not throw — either the value was replaced with a
        // sentinel or the getter never ran during logging.
        expect(() => JSON.stringify(entries[0])).not.toThrow();
    });

    it('preserves plain nested objects unchanged', () => {
        const base = Logger.for('SanTest');
        const task = makeTaskLogger(base, 'task-plain', null);

        task.info('ok', {
            nested: { a: 1, b: 'two', c: [1, 2, 3] },
        });

        const entries = entriesForTask('task-plain');
        expect(entries[0].data).toEqual({
            nested: { a: 1, b: 'two', c: [1, 2, 3] },
        });
    });
});

describe('formatConsoleMessage control-character stripping (security review 2026-09-13, C17)', () => {
    // The Subsonic dispatcher used to interpolate an attacker-controlled
    // `method` path segment directly into a log MESSAGE string, and
    // SvelteKit decodes `%0D%0A` in route params before the handler sees
    // it — so an authenticated Subsonic user could forge stdout log lines
    // (CRLF injection / fake log entries). formatConsoleMessage must strip
    // C0/C1 control characters from `entry.message` and `entry.context`
    // regardless of what any call site passes in, as defense-in-depth on
    // top of moving untrusted values into the JSON-escaped `data` field.

    it('strips \\r, \\n, and ESC from the message before writing to console', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const logger = Logger.for('CtrlMsgTest');
        logger.warn('a\r\nb\x1b[0m', {});

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const written = String(warnSpy.mock.calls[0]?.[0]);
        expect(written).not.toContain('\r');
        expect(written).not.toContain('\n');
        expect(written).not.toContain('\x1b');
        // Readable content on either side of the stripped bytes survives.
        expect(written).toContain('a');
        expect(written).toContain('b');

        warnSpy.mockRestore();
    });

    it('strips control characters from the context', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const logger = Logger.for('Ctrl\r\nContextTest');
        logger.warn('plain message', {});

        expect(warnSpy).toHaveBeenCalledTimes(1);
        const written = String(warnSpy.mock.calls[0]?.[0]);
        expect(written).not.toContain('\r');
        expect(written).not.toContain('\n');

        warnSpy.mockRestore();
    });

    it('leaves an ordinary message and context untouched', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const logger = Logger.for('PlainCtxTest');
        logger.warn('Unknown Subsonic method', { method: 'ping', username: 'alice' });

        const written = String(warnSpy.mock.calls[0]?.[0]);
        expect(written).toContain('[PlainCtxTest]');
        expect(written).toContain('Unknown Subsonic method');
        expect(written).toContain('"method":"ping"');

        warnSpy.mockRestore();
    });
});
