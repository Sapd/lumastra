// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for classifyInfraError's HTTP 5xx detection.
 *
 * Run with: npx vitest run src/lib/server/tasks/infra-retry.test.ts
 */

import { describe, it, expect } from 'vitest';
import { classifyInfraError, classifyMediaInfraError } from './infra-retry.js';

describe('classifyInfraError — HTTP 5xx detection', () => {
    describe('retryable (genuine HTTP/status 5xx context)', () => {
        const cases = [
            'HTTP 503',
            'status code: 500',
            '502 Bad Gateway',
            'Request failed with status 504',
        ];

        for (const msg of cases) {
            it(`retries "${msg}"`, () => {
                expect(classifyInfraError(new Error(msg))).toBe(true);
            });
        }
    });

    describe('NOT retryable (unrelated 3-digit number in the 500-599 range)', () => {
        const cases = ['expected 500 items', 'clip is 512 seconds', 'row 599 failed validation'];

        for (const msg of cases) {
            it(`does not retry "${msg}"`, () => {
                expect(classifyInfraError(new Error(msg))).toBe(false);
            });
        }
    });

    it('is case-insensitive on the context word and reason phrase', () => {
        expect(classifyInfraError(new Error('http 503'))).toBe(true);
        expect(classifyInfraError(new Error('502 bad gateway'))).toBe(true);
        expect(classifyInfraError(new Error('STATUS CODE: 500'))).toBe(true);
    });

    it('still matches classic 5xx reason phrases without preceding context', () => {
        expect(classifyInfraError(new Error('503 Service Unavailable'))).toBe(true);
        expect(classifyInfraError(new Error('500 Internal Server Error'))).toBe(true);
        expect(classifyInfraError(new Error('504 Gateway Timeout'))).toBe(true);
    });

    it('requires the context word to sit immediately before the number', () => {
        // "code" directly adjacent to the number is a valid context match...
        expect(classifyInfraError(new Error('code: 599'))).toBe(true);
        // ...but a stray "code" earlier in the sentence, unrelated to the
        // number, must not turn an ordinary count into a false positive.
        expect(classifyInfraError(new Error('the error code lookup returned row 599'))).toBe(false);
    });

    it('still retries plain network errors (unaffected by the 5xx regex change)', () => {
        expect(classifyInfraError(new Error('connect ECONNRESET'))).toBe(true);
        expect(classifyInfraError(new Error('read ETIMEDOUT'))).toBe(true);
    });

    it('does not retry permanent errors with no 5xx or network signature', () => {
        expect(
            classifyInfraError(new Error('duplicate key value violates unique constraint')),
        ).toBe(false);
        expect(classifyInfraError(new Error('invalid input syntax'))).toBe(false);
    });

    it('handles non-Error thrown values', () => {
        expect(classifyInfraError('status code: 500')).toBe(true);
        expect(classifyInfraError('expected 500 items')).toBe(false);
        expect(classifyInfraError({ weird: 'object' })).toBe(false);
    });
});

describe('structured infrastructure errors', () => {
    it('does not read a filesystem path in a non-transient coded error', () => {
        expect(
            classifyInfraError(
                Object.assign(new Error('ENOENT: /Connection Lost (2019).mkv'), { code: 'ENOENT' }),
            ),
        ).toBe(false);
    });
    it('ignores FFmpeg banners, input paths and metadata titles', () => {
        const stderr =
            "ffmpeg version 7\nInput #0, matroska, from '/Connection Lost (2019).mkv':\n    title : ENOSPC\nInvalid data found when processing input";
        expect(
            classifyMediaInfraError(
                Object.assign(new Error(stderr), { name: 'FFmpegError', exitCode: 1, stderr }),
            ),
        ).toBe(false);
    });
    it('recognizes a fixed ffmpeg write diagnostic without classifying the blob', () => {
        const stderr =
            "Input #0, from '/fixture.mkv':\nav_interleaved_write_frame(): No space left on device\nConversion failed!";
        expect(
            classifyMediaInfraError(
                Object.assign(new Error(stderr), { name: 'FFmpegError', exitCode: 1, stderr }),
            ),
        ).toBe(true);
    });
});

it('does not expand existing generic task policies to storage-full retries', () => {
    expect(
        classifyInfraError(Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })),
    ).toBe(false);
});
