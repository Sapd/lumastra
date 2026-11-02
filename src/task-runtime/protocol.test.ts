// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    encodeTaskFrame,
    TaskFrameDecoder,
    TaskCommandSchema,
    TaskReceiptSchema,
    TASK_MAX_FRAME_BYTES,
} from './protocol.js';

import command from '../../native/contracts/task-runtime/submit-v1.json';

describe('local task protocol', () => {
    it('roundtrips fragmented UTF-8 and coalesced frames without changing IDs or bigint generations', () => {
        const bytes = Buffer.concat([encodeTaskFrame(command), encodeTaskFrame({ result: true })]);
        const decoder = new TaskFrameDecoder();
        const messages: unknown[] = [];
        for (const byte of bytes) messages.push(...decoder.push(Uint8Array.of(byte)));
        decoder.finish();
        expect(messages).toEqual([command, { result: true }]);
        expect(TaskCommandSchema.parse(messages[0]).authority.generation).toBe('9007199254740993');
    });
    it('rejects unknown versions, unknown fields and executable or non-JSON payloads', () => {
        expect(TaskCommandSchema.safeParse({ ...command, version: 2 }).success).toBe(false);
        expect(TaskCommandSchema.safeParse({ ...command, context: {} }).success).toBe(false);
        expect(
            TaskCommandSchema.safeParse({ ...command, payload: { sql: () => {} } }).success,
        ).toBe(false);
        expect(
            TaskCommandSchema.safeParse({
                ...command,
                authority: { ...command.authority, generation: '0' },
            }).success,
        ).toBe(false);
    });
    it('rejects malformed and out-of-range generations without throwing inside validation', () => {
        for (const generation of ['abc', '-1', '0', '9223372036854775808']) {
            expect(
                TaskCommandSchema.safeParse({
                    ...command,
                    authority: { ...command.authority, generation },
                }).success,
            ).toBe(false);
        }
        expect(() => encodeTaskFrame({ execute: () => {} })).toThrow();
    });
    it('requires durable acceptance metadata and redacted error codes', () => {
        const { commandId, correlationId, authority, version } = command;
        const receipt = { commandId, correlationId, authority, version, status: 'accepted' };
        expect(TaskReceiptSchema.safeParse(receipt).success).toBe(false);
        expect(
            TaskReceiptSchema.parse({
                ...receipt,
                acceptedAt: '2026-10-17T12:00:00.000Z',
                runId: 'run_01JAV4X8T5S7FWEXAMPLE000001',
            }).status,
        ).toBe('accepted');
        expect(
            TaskReceiptSchema.safeParse({
                ...receipt,
                status: 'rejected',
                error: { code: 'stale_authority', retryable: false, secret: 'do not send' },
            }).success,
        ).toBe(false);
    });
    it('rejects over-limit advertised lengths before retaining a body and closes the decoder', () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(TASK_MAX_FRAME_BYTES + 1);
        const decoder = new TaskFrameDecoder();
        expect(() => decoder.push(header)).toThrow('frame length');
        expect(() => decoder.push(encodeTaskFrame({}))).toThrow('closed');
        expect(() => encodeTaskFrame('x'.repeat(TASK_MAX_FRAME_BYTES))).toThrow('size exceeded');
    });
    it('rejects invalid UTF-8, malformed JSON, truncated frames and oversized batches', () => {
        expect(() => new TaskFrameDecoder().push(Buffer.from([0, 0, 0, 1, 255]))).toThrow();
        expect(() => new TaskFrameDecoder().push(Buffer.from([0, 0, 0, 1, 123]))).toThrow();
        const decoder = new TaskFrameDecoder();
        decoder.push(Buffer.from([0, 0, 0, 9]));
        expect(() => decoder.finish()).toThrow('Truncated');
        expect(() =>
            new TaskFrameDecoder().push(
                Buffer.concat(Array.from({ length: 33 }, () => encodeTaskFrame({}))),
            ),
        ).toThrow('batch limit');
    });
});
