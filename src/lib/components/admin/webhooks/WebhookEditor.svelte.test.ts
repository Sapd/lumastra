// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import WebhookEditor from './WebhookEditor.svelte';
import { WEBHOOK_EVENT_TYPES } from '$lib/shared/webhook-events';

const apiPut = vi.hoisted(() => vi.fn(async () => ({ data: { id: 'hook' } })));
vi.mock('$lib/api/client.js', () => ({ apiPut, apiPost: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

it('offers exactly the delivered catalogue and drops retired stored filters on save', async () => {
    const existing = {
        id: 'hook',
        url: 'https://example.com/hook',
        label: 'Hook',
        active: true,
        includeProgress: false,
        eventFilter: ['org.lumastra.task.run.started', 'org.lumastra.task.run.stage.completed'],
    } as never;
    const { container } = render(WebhookEditor, { existing, onSaved: vi.fn(), onCancel: vi.fn() });
    const offered = [...container.querySelectorAll('[data-event-type]')].map((node) =>
        node.getAttribute('data-event-type'),
    );
    expect(offered).toEqual(WEBHOOK_EVENT_TYPES);
    await fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() =>
        expect(apiPut).toHaveBeenCalledWith(
            '/api/webhooks/hook',
            expect.anything(),
            expect.objectContaining({ eventFilter: ['org.lumastra.task.run.started'] }),
        ),
    );
});

it('generates a fresh signing secret and explains its signature header', async () => {
    render(WebhookEditor, { onSaved: vi.fn(), onCancel: vi.fn() });
    expect(screen.getByText(/X-Lumastra-Signature/)).toBeTruthy();
    const secret = screen.getByLabelText('Signing Secret') as HTMLInputElement;
    await fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    const first = secret.value;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(secret.value).toMatch(/^[a-f0-9]{64}$/);
    expect(secret.value).not.toBe(first);
});
