// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { saveHomeWidgetOrder } from './home-widget-order';
import { updateWidgetOrder } from '$lib/api/user';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';

vi.mock('$lib/api/user', () => ({ updateWidgetOrder: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

test('resolved API errors restore the prior visible order and report failure', async () => {
    let visible = ['watchlist', 'for-you'];
    const previous = ['for-you', 'watchlist'];
    vi.mocked(updateWidgetOrder).mockResolvedValue({ data: null, error: 'offline', status: 503 });
    await saveHomeWidgetOrder(visible, () => {
        visible = previous;
    });
    expect(visible).toEqual(previous);
    expect(toasts.error).toHaveBeenCalledWith(m.settings_home_save_error());
});

test('thrown network errors also roll back', async () => {
    const rollback = vi.fn();
    vi.mocked(updateWidgetOrder).mockRejectedValue(new Error('offline'));
    await saveHomeWidgetOrder(['watchlist'], rollback);
    expect(rollback).toHaveBeenCalledOnce();
    expect(toasts.error).toHaveBeenCalledOnce();
});

test('successful saves keep the new order without changing hidden-widget preferences', async () => {
    const rollback = vi.fn();
    vi.mocked(updateWidgetOrder).mockResolvedValue({
        data: { username: 'viewer', widgetOrder: ['watchlist'], hiddenWidgets: [] },
        error: null,
        status: 200,
    });
    await saveHomeWidgetOrder(['watchlist'], rollback);
    expect(updateWidgetOrder).toHaveBeenCalledWith({ widgetOrder: ['watchlist'] });
    expect(rollback).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
});
