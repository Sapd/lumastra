// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { updateWidgetOrder } from '$lib/api/user';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';

/** Persist one completed drag, restoring the visible order on any API failure. */
export async function saveHomeWidgetOrder(order: string[], rollback: () => void): Promise<void> {
    try {
        const { data, error } = await updateWidgetOrder({ widgetOrder: order });
        if (error || !data) throw new Error(error ?? 'Missing widget configuration');
    } catch {
        rollback();
        toasts.error(m.settings_home_save_error());
    }
}
