// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    get: vi.fn(),
    post: vi.fn(),
    poll: vi.fn(),
    cancel: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet: mocks.get, apiPost: mocks.post }));
vi.mock('$lib/api/admin.js', () => ({
    awaitFileHealthRecheck: mocks.poll,
    cancelRun: mocks.cancel,
}));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { success: mocks.success, info: mocks.info, error: mocks.error },
}));
import TaskFailuresList from './TaskFailuresList.svelte';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const item = {
    id: 'failure1',
    itemId: FILE,
    title: 'Damaged trailer',
    reason: 'truncated_video',
    occurredAt: '2026-10-01T00:00:00Z',
};
beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({
        data: { items: [item], page: { limit: 50, total: 1, hasMore: false } },
    });
    mocks.post.mockResolvedValue({ data: { retried: false, runId: 'run_selected' } });
});
afterEach(cleanup);
it('media-probe acceptance stays pending, then reports a localized genuine warning and reloads', async () => {
    let finish: (value: unknown) => void = () => {};
    mocks.poll.mockImplementation(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    expect(await screen.findByText('Duration mismatch needs review')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getAllByText('Damaged trailer').length).toBeGreaterThan(0);
    finish({
        data: {
            fileId: FILE,
            outcome: 'warning',
            issues: [{ type: 'truncated_video', detected_at: '2026-10-24T00:00:00Z' }],
        },
    });
    expect(await screen.findByText(/Recheck completed; warnings remain/)).toBeTruthy();
    expect(mocks.info).toHaveBeenCalledWith(
        expect.stringContaining('Duration mismatch needs review'),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.success).not.toHaveBeenCalledWith('Retry queued');
});
it('unrelated task callback semantics keep the existing queued toast', async () => {
    mocks.post.mockResolvedValue({ data: { retried: true } });
    render(TaskFailuresList, { taskId: 'other-task', supportsRetry: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(mocks.success).toHaveBeenCalledWith('Retry queued');
    expect(mocks.poll).not.toHaveBeenCalled();
});

function deferred() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
it('accepted pending retries expose their run and Cancel waits for terminal state after a refusal', async () => {
    const terminal = deferred();
    mocks.poll.mockReturnValue(terminal.promise);
    mocks.cancel
        .mockResolvedValueOnce({ data: { accepted: false } })
        .mockResolvedValueOnce({ data: { accepted: true } });
    render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(
        (await screen.findByRole('link', { name: 'View recheck run' })).getAttribute('href'),
    ).toContain('run_selected');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancel).toHaveBeenCalledWith('run_selected');
    expect(await screen.findByText(/Cancellation could not be confirmed/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Recheck cancelled/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retrying…' }).hasAttribute('disabled')).toBe(true);
    terminal.resolve({ data: { fileId: FILE, outcome: 'cancelled', issues: [] } });
    expect(await screen.findByText(/Recheck cancelled/)).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
});
it('a task switch aborts tracking and fences an old acceptance from populating the next task', async () => {
    const accepted = deferred();
    mocks.post.mockReturnValueOnce(accepted.promise);
    const view = render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    const signal = mocks.post.mock.calls[0][3].signal;
    await view.rerender({ taskId: 'other-task', supportsRetry: true });
    expect(signal.aborted).toBe(true);
    accepted.resolve({ data: { retried: false, runId: 'run_old' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.poll).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'View recheck run' })).toBeNull();
    expect(mocks.get.mock.calls.filter((call) => call[0].includes('other-task'))).toHaveLength(1);
});
it('a repeated attempt clears the previous result and cancel target until the new run is accepted', async () => {
    mocks.poll.mockResolvedValueOnce({
        data: { fileId: FILE, outcome: 'warning', issues: [{ type: 'truncated_video' }] },
    });
    render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText(/Recheck completed; warnings remain/);
    const accepted = deferred();
    mocks.post.mockReturnValueOnce(accepted.promise);
    const terminal = deferred();
    mocks.poll.mockReturnValueOnce(terminal.promise);
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(/Recheck completed; warnings remain/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    accepted.resolve({ data: { retried: false, runId: 'run_new' } });
    mocks.cancel.mockResolvedValue({ data: { accepted: true } });
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mocks.cancel).toHaveBeenLastCalledWith('run_new');
    terminal.resolve({ data: { fileId: FILE, outcome: 'cancelled', issues: [] } });
    await screen.findByText(/Recheck cancelled/);
});

it('a task switch fences an old terminal continuation from showing results, toasts or a new-task reload', async () => {
    const terminal = deferred();
    mocks.poll.mockReturnValueOnce(terminal.promise);
    const view = render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Cancel' });
    await view.rerender({ taskId: 'other-task', supportsRetry: true });
    terminal.resolve({ data: { fileId: FILE, outcome: 'healthy', issues: [] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Recheck completed/)).toBeNull();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.get.mock.calls.filter((call) => call[0].includes('other-task'))).toHaveLength(1);
});

it('keeps recorded probe issues distinct from the current assessment after a fresh mount', async () => {
    mocks.get.mockResolvedValue({
        data: {
            items: [{ ...item, failureCount: 2 }],
            page: { limit: 50, total: 1, hasMore: false },
        },
    });
    const view = render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    expect(await screen.findByText('Showing 1 of 1 files with recorded issues')).toBeTruthy();
    expect(screen.getByText(/Latest recorded issue/)).toBeTruthy();
    expect(screen.getByText(/2 recorded observations/)).toBeTruthy();
    expect(screen.queryByText(/failed 2×/)).toBeNull();
    expect(screen.getByText(/A completed recheck can still leave warnings/)).toBeTruthy();
    expect(
        screen.getByRole('link', { name: 'Browse current file health' }).getAttribute('href'),
    ).toBe('/admin/system/health#files');
    expect(screen.queryByText(/unresolved items/)).toBeNull();
    view.unmount();
    render(TaskFailuresList, { taskId: 'media-probe', supportsRetry: true });
    expect(await screen.findByText('Showing 1 of 1 files with recorded issues')).toBeTruthy();
    expect(screen.getByText('Duration mismatch needs review')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.poll).not.toHaveBeenCalled();
});
