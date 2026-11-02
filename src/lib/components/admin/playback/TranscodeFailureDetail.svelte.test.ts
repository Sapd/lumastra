// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Regression coverage for the empty-`libraryRoots` edge case caught in path-tracing
 * review: `redactPaths` loops over `libraryRoots`, so an empty array (no filesystem
 * library roots configured) silently disables ALL path redaction while "Copy for
 * GitHub" still implies a redacted report. The button must fail loud — disabled,
 * with an explanation — rather than let an unredacted report ship under a
 * "redacted" label.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TranscodeFailureDetail from './TranscodeFailureDetail.svelte';
import type { TranscodeFailureAttempt } from '$lib/schemas/api-transcode-failures.js';

vi.mock('$lib/api/client.js', () => ({ apiPost: vi.fn() }));

function makeAttempt(overrides: Partial<TranscodeFailureAttempt> = {}): TranscodeFailureAttempt {
    return {
        id: 'attempt-1',
        jobId: 'job-1',
        attempt: 1,
        occurredAt: new Date().toISOString(),
        outcome: 'failed',
        exitCode: 218,
        signal: null,
        category: 'gpu-init',
        summary: 'boom',
        argv: ['-i', '/data/movies/x.mkv'],
        stderrTail: null,
        encoder: 'h264_qsv',
        hwaccel: 'qsv',
        mediaId: null,
        fileId: null,
        source: null,
        decision: null,
        env: null,
        transcodeSpeed: null,
        probeDump: null,
        ...overrides,
    };
}

describe('TranscodeFailureDetail — redaction-unavailable state', () => {
    afterEach(() => cleanup());

    it('disables "Copy for GitHub" and shows an explanation when libraryRoots is empty', () => {
        render(TranscodeFailureDetail, {
            attempts: [makeAttempt()],
            roots: { libraryRoots: [] },
        });

        const githubButton = screen.getByRole('button', {
            name: /copy for github/i,
        }) as HTMLButtonElement;
        expect(githubButton.disabled).toBe(true);

        const rawButton = screen.getByRole('button', { name: /copy raw/i }) as HTMLButtonElement;
        expect(rawButton.disabled).toBe(false);

        expect(screen.getByText(/paths cannot be redacted/i)).toBeTruthy();
    });

    it('keeps "Copy for GitHub" enabled when at least one library root is configured', () => {
        render(TranscodeFailureDetail, {
            attempts: [makeAttempt()],
            roots: { libraryRoots: ['/data/movies'] },
        });

        const githubButton = screen.getByRole('button', {
            name: /copy for github/i,
        }) as HTMLButtonElement;
        expect(githubButton.disabled).toBe(false);
        expect(screen.queryByText(/paths cannot be redacted/i)).toBeNull();
    });
});

describe('GPU failure configuration links', () => {
    afterEach(cleanup);
    it('opens the hardware category for GPU failures', () => {
        render(TranscodeFailureDetail, {
            attempts: [makeAttempt()],
            roots: { libraryRoots: ['/media'] },
        });
        expect(
            screen
                .getByRole('link', { name: 'Configure hardware acceleration' })
                .getAttribute('href'),
        ).toContain('/admin/settings/playback?category=ffmpeg-hardware');
    });
    it('does not suggest GPU configuration for a software-only failure', () => {
        render(TranscodeFailureDetail, {
            attempts: [makeAttempt({ hwaccel: 'none', encoder: 'libx264', category: 'unknown' })],
            roots: { libraryRoots: ['/media'] },
        });
        expect(screen.queryByRole('link', { name: 'Configure hardware acceleration' })).toBeNull();
    });
});
