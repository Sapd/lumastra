// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const TASK_PROTOCOL_VERSION = 1;
export const TASK_MAX_FRAME_BYTES = 256 * 1024;
export const TASK_MAX_IN_FLIGHT = 32;
export const TASK_COMMAND_TIMEOUT_MS = 30_000;

const id = z.string().uuid();
const authority = z
    .object({
        partition: z.string().regex(/^[a-z][a-z0-9:._-]{0,127}$/),
        // Decimal text preserves PostgreSQL bigint across JavaScript/Rust.
        generation: z
            .string()
            .regex(/^[1-9][0-9]{0,18}$/)
            .refine(
                (value) =>
                    /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n,
                'Generation exceeds PostgreSQL bigint',
            ),
        ownerId: id,
    })
    .strict();

// Private command metadata only. SDK contexts and credentials never cross it.
export const TaskCommandSchema = z
    .object({
        version: z.literal(TASK_PROTOCOL_VERSION),
        commandId: id,
        correlationId: id,
        authority,
        catalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
        operation: z.enum(['submit', 'cancel', 'drain']),
        // Run input/options are validated by the existing TypeScript SDK adapter;
        // protocol v1 does not reimplement SDK schema or BullMQ persistence.
        payload: z.json(),
    })
    .strict();
export type TaskCommand = z.infer<typeof TaskCommandSchema>;

export const TaskReceiptSchema = z
    .object({
        version: z.literal(TASK_PROTOCOL_VERSION),
        commandId: id,
        correlationId: id,
        authority,
        status: z.enum(['accepted', 'completed', 'rejected']),
        // acceptedAt may be sent only after receipt + accepted state commit.
        acceptedAt: z.string().datetime().optional(),
        runId: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9_-]+$/)
            .optional(),
        error: z
            .object({
                code: z.enum([
                    'version_mismatch',
                    'stale_authority',
                    'catalog_mismatch',
                    'invalid_command',
                    'unavailable',
                ]),
                retryable: z.boolean(),
            })
            .strict()
            .optional(),
    })
    .strict()
    .superRefine((receipt, ctx) => {
        if (receipt.status !== 'rejected' && !receipt.acceptedAt) {
            ctx.addIssue({ code: 'custom', message: 'Durable acceptance timestamp required' });
        }
        if (receipt.status === 'rejected' && !receipt.error) {
            ctx.addIssue({ code: 'custom', message: 'Rejected receipt requires error code' });
        }
    });
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

/** 4-byte unsigned big-endian byte count, then exactly that many UTF-8 JSON bytes. */
export function encodeTaskFrame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(z.json().parse(value)), 'utf8');
    if (body.length === 0 || body.length > TASK_MAX_FRAME_BYTES)
        throw new Error('Task frame size exceeded');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length);
    return Buffer.concat([header, body]);
}

/** Bounded incremental decoder. Callers must bound decoded in-flight requests too. */
export class TaskFrameDecoder {
    private readonly header = Buffer.alloc(4);
    private headerUsed = 0;
    private body: Buffer | undefined;
    private bodyUsed = 0;
    private failed = false;

    push(chunk: Uint8Array): unknown[] {
        if (this.failed) throw new Error('Task decoder is closed after protocol failure');
        const messages: unknown[] = [];
        try {
            let offset = 0;
            while (offset < chunk.length) {
                if (!this.body) {
                    const count = Math.min(4 - this.headerUsed, chunk.length - offset);
                    this.header.set(chunk.subarray(offset, offset + count), this.headerUsed);
                    this.headerUsed += count;
                    offset += count;
                    if (this.headerUsed !== 4) continue;
                    const length = this.header.readUInt32BE(0);
                    if (length === 0 || length > TASK_MAX_FRAME_BYTES)
                        throw new Error('Invalid task frame length');
                    // Allocate once per bounded frame. Fragmenting into single
                    // bytes must not trigger quadratic concatenation/copying.
                    this.body = Buffer.allocUnsafe(length);
                    this.bodyUsed = 0;
                }
                const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
                this.body.set(chunk.subarray(offset, offset + count), this.bodyUsed);
                this.bodyUsed += count;
                offset += count;
                if (this.bodyUsed !== this.body.length) continue;
                const text = new TextDecoder('utf-8', { fatal: true }).decode(this.body);
                messages.push(JSON.parse(text) as unknown);
                this.body = undefined;
                this.bodyUsed = 0;
                this.headerUsed = 0;
                if (messages.length > TASK_MAX_IN_FLIGHT)
                    throw new Error('Task frame batch limit exceeded');
            }
            return messages;
        } catch (err) {
            this.body = undefined;
            this.failed = true;
            throw err;
        }
    }

    finish(): void {
        if (this.headerUsed !== 0 || this.body) {
            this.body = undefined;
            this.failed = true;
            throw new Error('Truncated task frame');
        }
    }
}
