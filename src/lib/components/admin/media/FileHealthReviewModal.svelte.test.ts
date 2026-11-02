// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { audioTailAssessmentFixture } from './audio-tail-assessment.fixture.js';
const reviewFileHealth = vi.fn();
vi.mock('$lib/api/admin', () => ({
    reviewFileHealth: (...args: unknown[]) => reviewFileHealth(...args),
}));
const { default: FileHealthReviewModal } = await import('./FileHealthReviewModal.svelte');
const fileId = '00000000-0000-4000-8000-000000000001';
const issueKey = 'a'.repeat(64);
const snapshot = 'b'.repeat(64);
const finding = {
    key: issueKey,
    type: 'duration_mismatch',
    expectedDuration: 120,
    actualDuration: 119,
    detail: 'Recorded duration differs',
    state: 'needs-review',
};
const history = {
    id: '00000000-0000-4000-8000-000000000002',
    issueKey,
    issueType: 'duration_mismatch',
    reason: 'Keep this file and hide this duration warning.',
    evidence: 'Accepted the current snapshot; content remains unverified.',
    decidedBy: 'library-admin',
    decidedAt: '2026-10-25T12:00:00Z',
    state: 'current',
};
function preview(overrides: Record<string, unknown> = {}) {
    return {
        fileId,
        fileName: 'Cloud Harbor.mkv',
        filePath: '/library/Cloud Harbor.mkv',
        assessment: audioTailAssessmentFixture(fileId, 'near_silent'),
        snapshot,
        eligible: true,
        findings: [finding],
        history: [],
        ...overrides,
    };
}
function response(value = preview()) {
    return { data: { action: 'preview', preview: value }, error: null };
}
beforeEach(() => {
    reviewFileHealth.mockReset();
});
afterEach(cleanup);

test('one click accepts the exact warning without typing or checkbox; Show again restores it', async () => {
    reviewFileHealth
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce({ data: { action: 'confirm', reviewed: 1 } })
        .mockResolvedValueOnce(
            response(
                preview({
                    eligible: false,
                    findings: [{ ...finding, state: 'reviewed' }],
                    history: [history],
                }),
            ),
        )
        .mockResolvedValueOnce({ data: { action: 'revoke', revoked: true } })
        .mockResolvedValueOnce(response(preview({ history: [{ ...history, state: 'revoked' }] })));
    render(FileHealthReviewModal, { props: { fileId, onclose: vi.fn() } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep this file' }));
    expect(reviewFileHealth).toHaveBeenNthCalledWith(2, {
        action: 'confirm',
        fileId,
        snapshot,
        issueKeys: [issueKey],
    });
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((await screen.findByRole('status')).textContent).toContain('File kept.');
    expect(screen.queryByText(/Use the existing Recheck action/)).toBeNull();
    await fireEvent.click(await screen.findByRole('button', { name: 'Show this warning again' }));
    expect(reviewFileHealth).toHaveBeenNthCalledWith(4, {
        action: 'revoke',
        fileId,
        reviewId: history.id,
    });
    expect(await screen.findByRole('button', { name: 'Keep this file' })).toBeTruthy();
    expect(screen.getByText(/120s.*119s/)).toBeTruthy();
});

test('blocked technical evidence cannot be accepted', async () => {
    reviewFileHealth.mockResolvedValue(
        response(
            preview({
                eligible: false,
                blockedReason: 'needs-recheck',
                findings: [{ ...finding, state: 'blocked' }],
            }),
        ),
    );
    render(FileHealthReviewModal, { props: { fileId, onclose: vi.fn() } });
    expect(await screen.findByText(/successful current recheck is required/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep this file' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
});

test('a stale conflict requires a new preview and never reuses its snapshot', async () => {
    reviewFileHealth
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce({ error: 'File evidence changed.', status: 409 })
        .mockResolvedValueOnce(response(preview({ snapshot: 'c'.repeat(64) })))
        .mockResolvedValueOnce({ data: { action: 'confirm', reviewed: 1 } })
        .mockResolvedValueOnce(response());
    render(FileHealthReviewModal, { props: { fileId, onclose: vi.fn() } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep this file' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep this file' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry preview' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Keep this file' }));
    await waitFor(() =>
        expect(reviewFileHealth).toHaveBeenNthCalledWith(
            4,
            expect.objectContaining({ snapshot: 'c'.repeat(64) }),
        ),
    );
});

test('records an optional note and paints durable success before a parent refresh finishes', async () => {
    let finish: (() => void) | undefined;
    reviewFileHealth
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce({ data: { action: 'confirm', reviewed: 1 } })
        .mockResolvedValueOnce(response());
    render(FileHealthReviewModal, {
        props: {
            fileId,
            onclose: vi.fn(),
            onchanged: () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                }),
        },
    });
    const keep = await screen.findByRole('button', { name: 'Keep this file' });
    await fireEvent.input(screen.getByLabelText('Notes (optional)'), { target: { value: 'OK' } });
    await fireEvent.click(keep);
    expect((await screen.findByRole('status')).textContent).toContain('File kept.');
    expect(reviewFileHealth).toHaveBeenNthCalledWith(2, expect.objectContaining({ reason: 'OK' }));
    expect(finish).toBeTypeOf('function');
    finish?.();
});
