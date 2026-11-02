// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { computeIdentity, identityKey, sanitizeIdentity } from './identity';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

// Helper to create a minimal TaskDefinition for testing
function createTestTask(
    id: string,
    identityFor: (input: Record<string, unknown>) => string,
): TaskDefinition {
    return {
        id,
        name: 'Test Task',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '0.0.1',
        capabilities: {},
        resourceClass: 'maintenance',
        identityFor: identityFor as (input: unknown) => string,
        inputSchema: null as unknown as TaskDefinition['inputSchema'],
        execute: async () => ({ success: true }),
    } as TaskDefinition;
}

describe('computeIdentity', () => {
    it('should format identity as taskId~~tail', () => {
        const task = createTestTask(
            'file-system-scan',
            (input) => ((input as Record<string, unknown>).libraryGroupId as string) ?? 'all',
        );
        const result = computeIdentity(task, { libraryGroupId: 'group-123' });
        expect(result).toBe('file-system-scan~~group-123');
    });

    it('should use default value from identityFor', () => {
        const task = createTestTask(
            'file-system-scan',
            (input) => ((input as Record<string, unknown>).libraryGroupId as string) ?? 'all',
        );
        const result = computeIdentity(task, {});
        expect(result).toBe('file-system-scan~~all');
    });

    it('should throw on empty identityFor result', () => {
        const task = createTestTask('bad-task', () => '');
        expect(() => computeIdentity(task, {})).toThrow('identity formula cannot be empty');
    });

    it('should throw on identity exceeding 256 chars', () => {
        const task = createTestTask('bad-task', () => 'x'.repeat(257));
        expect(() => computeIdentity(task, {})).toThrow('exceeds 256 characters');
    });

    it('should throw on identity with control characters', () => {
        const task = createTestTask('bad-task', () => 'foo\nbar');
        expect(() => computeIdentity(task, {})).toThrow('control characters');
    });

    it('should allow long taskIds', () => {
        const longId = 'very-long-task-name-with-many-hyphens-' + 'x'.repeat(100);
        const task = createTestTask(longId, () => 'test-identity');
        const result = computeIdentity(task, {});
        expect(result).toContain('~~test-identity');
        expect(result.startsWith(longId + '~~')).toBe(true);
    });

    it('should handle UUID-like identity values', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const task = createTestTask('my-task', () => uuid);
        const result = computeIdentity(task, {});
        expect(result).toBe(`my-task~~${uuid}`);
    });

    it('should handle numeric string identity values', () => {
        const task = createTestTask('numeric-task', (input) =>
            String((input as Record<string, unknown>).id),
        );
        const result = computeIdentity(task, { id: 12345 });
        expect(result).toBe('numeric-task~~12345');
    });

    it('should be deterministic: same input produces same output twice', () => {
        const task = createTestTask(
            'scan-task',
            (input) => ((input as Record<string, unknown>).libraryGroupId as string) ?? 'default',
        );
        const input = { libraryGroupId: 'stable-group' };
        const result1 = computeIdentity(task, input);
        const result2 = computeIdentity(task, input);
        expect(result1).toBe(result2);
    });

    it('should reject colons in identity formula (BullMQ jobId constraint)', () => {
        const task = createTestTask('special-task', () => 'group: id-123 xyz');
        expect(() => computeIdentity(task, {})).toThrow(':');
    });

    it('should handle spaces and hyphens in identity', () => {
        const task = createTestTask('special-task', () => 'group id-123 xyz');
        const result = computeIdentity(task, {});
        expect(result).toBe('special-task~~group id-123 xyz');
    });
});

describe('identityKey', () => {
    it('should format identity key as task:identity:taskId:formula', () => {
        const key = identityKey('file-system-scan', 'all');
        expect(key).toBe('task:identity:file-system-scan:all');
    });

    it('should preserve formula exactly', () => {
        const key = identityKey('my-task', 'group-123-uuid');
        expect(key).toBe('task:identity:my-task:group-123-uuid');
    });

    it('should handle UUIDs in formula', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const key = identityKey('task-with-uuid', uuid);
        expect(key).toContain(uuid);
    });

    it('should handle long task IDs', () => {
        const longId = 'task-' + 'x'.repeat(150);
        const key = identityKey(longId, 'formula');
        expect(key).toContain(longId);
        expect(key).toContain('formula');
    });

    it('should handle 256-char formulas', () => {
        const maxFormula = 'x'.repeat(256);
        const key = identityKey('task-id', maxFormula);
        expect(key).toContain(maxFormula);
    });
});

describe('sanitizeIdentity', () => {
    it('should return input unchanged for valid 1-char string', () => {
        const result = sanitizeIdentity('x');
        expect(result).toBe('x');
    });

    it('should return input unchanged for valid multi-char string', () => {
        const result = sanitizeIdentity('group-123-abc');
        expect(result).toBe('group-123-abc');
    });

    it('should return input unchanged for 256-char string', () => {
        const valid = 'x'.repeat(256);
        const result = sanitizeIdentity(valid);
        expect(result).toBe(valid);
    });

    it('should return input unchanged for UUID string', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const result = sanitizeIdentity(uuid);
        expect(result).toBe(uuid);
    });

    it('should return input unchanged for strings with spaces (no colons)', () => {
        const valid = 'group id 123';
        const result = sanitizeIdentity(valid);
        expect(result).toBe(valid);
    });

    it('should reject strings containing a colon (BullMQ jobId constraint)', () => {
        expect(() => sanitizeIdentity('group: id')).toThrow(':');
        expect(() => sanitizeIdentity(':leading')).toThrow(':');
        expect(() => sanitizeIdentity('trailing:')).toThrow(':');
    });

    it('should reject strings containing "~~" (reserved as taskId separator)', () => {
        expect(() => sanitizeIdentity('foo~~bar')).toThrow('~~');
        expect(() => sanitizeIdentity('~~leading')).toThrow('~~');
        expect(() => sanitizeIdentity('trailing~~')).toThrow('~~');
    });

    it('should throw for empty string', () => {
        expect(() => sanitizeIdentity('')).toThrow('cannot be empty');
    });

    it('should throw for string exceeding 256 chars', () => {
        const tooLong = 'x'.repeat(257);
        expect(() => sanitizeIdentity(tooLong)).toThrow('exceeds 256 characters');
    });

    it('should throw for string with newline', () => {
        expect(() => sanitizeIdentity('foo\nbar')).toThrow('control characters');
    });

    it('should throw for string with tab', () => {
        expect(() => sanitizeIdentity('foo\tbar')).toThrow('control characters');
    });

    it('should throw for string with null byte', () => {
        expect(() => sanitizeIdentity('foo\x00bar')).toThrow('control characters');
    });

    it('should throw for string with DEL character (0x7f)', () => {
        expect(() => sanitizeIdentity('foo\x7fbar')).toThrow('control characters');
    });

    it('should throw for string with various C0 control characters', () => {
        // Test a few representative control chars
        for (let code = 0x00; code <= 0x1f; code++) {
            const str = 'foo' + String.fromCharCode(code) + 'bar';
            expect(() => sanitizeIdentity(str)).toThrow('control characters');
        }
    });

    it('should allow numbers and punctuation', () => {
        const result = sanitizeIdentity('123-456.789_abc');
        expect(result).toBe('123-456.789_abc');
    });

    it('should allow special valid characters (no colon)', () => {
        const result = sanitizeIdentity('id-group@zone~item');
        expect(result).toBe('id-group@zone~item');
    });

    it('Critical-2 (F5): rejects identity containing "#" (runId delimiter collision)', () => {
        // Encoded jobName format is `<taskId>~~<formula>#<runId>`. Allowing
        // `#` in `formula` makes lastIndexOf('#') split incorrectly when the
        // formula contains `#run_…`, causing the SSE/runner decoder to grab
        // the wrong runId and silently drop terminal events.
        expect(() => sanitizeIdentity('foo#bar')).toThrow('#');
        expect(() => sanitizeIdentity('plugin-prefix#run_OPS_NOTE')).toThrow('#');
        expect(() => sanitizeIdentity('#leading')).toThrow('#');
        expect(() => sanitizeIdentity('trailing#')).toThrow('#');
    });
});

describe('Property tests (simulated without fast-check)', () => {
    it('computeIdentity is deterministic for stable identityFor', () => {
        // Property: For any task + input where identityFor returns a stable value,
        // computeIdentity returns the same result twice
        const inputs: Array<Record<string, unknown>> = [
            { id: 123 },
            { scope: 'user-1' },
            { libraryGroupId: 'group-x', mode: 'manual' },
            { paths: ['/media'] },
        ];

        for (const input of inputs) {
            // Strip colons + tildes from the JSON serialization — sanitizeIdentity
            // rejects both (BullMQ rejects colons in jobIds; `~~` is the reserved
            // jobId separator). The determinism property holds regardless.
            const task = createTestTask('stable-task', (inp) =>
                JSON.stringify(inp).replace(/[:~]/g, '-').substring(0, 100),
            );
            const result1 = computeIdentity(task, input);
            const result2 = computeIdentity(task, input);
            expect(result1).toBe(result2);
        }
    });

    it('sanitizeIdentity is idempotent for valid strings', () => {
        // Property: For any string passing validation, sanitizeIdentity(x) === x.
        // Colons are now banned (BullMQ jobId constraint) so test inputs cannot
        // include them; see the dedicated colon-rejection test above.
        const validStrings = [
            'single',
            'with-hyphens',
            'with_underscores',
            'with.dots',
            '123-numeric',
            'UUID-550e8400-e29b-41d4-a716-446655440000',
            'with spaces',
            'mixed-123_abc.xyz~id',
        ];

        for (const str of validStrings) {
            const result = sanitizeIdentity(str);
            expect(result).toBe(str);
        }
    });

    it('sanitizeIdentity rejects all lengths > 256', () => {
        // Property: For any string > 256 chars, sanitizeIdentity throws
        const testLengths = [257, 300, 500, 1000];

        for (const len of testLengths) {
            const str = 'x'.repeat(len);
            expect(() => sanitizeIdentity(str)).toThrow('exceeds 256 characters');
        }
    });

    it('sanitizeIdentity rejects all C0 + DEL control chars', () => {
        // Property: For any string containing control char, sanitizeIdentity throws
        const controlChars: number[] = [];

        // C0 controls: 0x00-0x1f
        for (let i = 0x00; i <= 0x1f; i++) {
            controlChars.push(i);
        }
        // DEL: 0x7f
        controlChars.push(0x7f);

        for (const code of controlChars) {
            const str = 'foo' + String.fromCharCode(code) + 'bar';
            expect(() => sanitizeIdentity(str)).toThrow('control characters');
        }
    });

    it('identityKey formats consistently for all valid inputs', () => {
        // Property: identityKey(taskId, formula) always starts with 'task:identity:' prefix
        const cases: Array<[string, string]> = [
            ['task-1', 'formula-1'],
            ['my-scan', 'group-uuid'],
            ['long-' + 'x'.repeat(50), 'y'.repeat(100)],
        ];

        for (const [taskId, formula] of cases) {
            const key = identityKey(taskId, formula);
            expect(key).toMatch(/^task:identity:/);
            expect(key).toContain(taskId);
            expect(key).toContain(formula);
        }
    });
});

describe('computeIdentity reserved-char guard (F6.2)', () => {
    it('passes for a normal kebab-case task id', () => {
        const task = createTestTask('tmdb-metadata-sync', () => 'group-1');
        expect(() => computeIdentity(task, {})).not.toThrow();
        expect(computeIdentity(task, {})).toBe('tmdb-metadata-sync~~group-1');
    });

    it('throws when task.id contains "~~"', () => {
        const task = createTestTask('bad~~task', () => 'tail');
        expect(() => computeIdentity(task, {})).toThrow(/reserved sequence "~~"/);
        expect(() => computeIdentity(task, {})).toThrow(/bad~~task/);
    });

    it('throws when task.id contains "#"', () => {
        const task = createTestTask('bad#task', () => 'tail');
        expect(() => computeIdentity(task, {})).toThrow(/reserved sequence "#"/);
        expect(() => computeIdentity(task, {})).toThrow(/bad#task/);
    });

    it('throws when task.id contains ":"', () => {
        const task = createTestTask('bad:task', () => 'tail');
        expect(() => computeIdentity(task, {})).toThrow(/reserved sequence ":"/);
        expect(() => computeIdentity(task, {})).toThrow(/bad:task/);
    });
});
