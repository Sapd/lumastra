// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A pending Lumastra security release cannot be acknowledged or snoozed; the
 * server refuses both (attention-service.ts), so the row must not offer the
 * buttons. Pending plugin lifecycle changes also stay visible until applied.
 */

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import { attentionItem } from '$lib/shared/__fixtures__/attention-section-ids.js';
import { LUMASTRA_SECURITY_UPDATE_ATTENTION_ID } from '$lib/shared/attention-persistent.js';

const AttentionItemRow = (await import('./AttentionItemRow.svelte')).default;

afterEach(cleanup);

function renderRow(id: string, severity: 'critical' | 'warning' | 'info'): void {
    render(AttentionItemRow, {
        props: {
            item: attentionItem({ id, severity }),
            onAck: vi.fn(),
            onSnooze: vi.fn(),
        },
    });
}

describe('AttentionItemRow ack/snooze', () => {
    it('hides both for the persistent security-update item', () => {
        renderRow(LUMASTRA_SECURITY_UPDATE_ATTENTION_ID, 'critical');
        expect(screen.queryByRole('button', { name: m.admin_ops_ack() })).toBeNull();
        expect(screen.queryByRole('button', { name: m.admin_ops_snooze() })).toBeNull();
    });

    it('hides both while plugin changes are waiting for a restart', () => {
        renderRow('settings:plugin-restart', 'warning');
        expect(screen.queryByRole('button', { name: m.admin_ops_ack() })).toBeNull();
        expect(screen.queryByRole('button', { name: m.admin_ops_snooze() })).toBeNull();
    });

    it('keeps both for a normal update notice', () => {
        renderRow('lumastra-update:release', 'info');
        expect(screen.getByRole('button', { name: m.admin_ops_ack() })).toBeTruthy();
        expect(screen.getByRole('button', { name: m.admin_ops_snooze() })).toBeTruthy();
    });
});
