// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

/** Historical upstream bodies may contain keys; expose only controlled causes. */
export function webhookDeliveryError(
    status: number | null | undefined,
    error: string | null | undefined,
): string | undefined {
    if (status != null && status >= 300) {
        const reason =
            status === 401 || status === 403
                ? m.webhook_delivery_auth()
                : status === 404 || status === 410
                  ? m.webhook_delivery_removed()
                  : status >= 500
                    ? m.admin_connection_server({ status })
                    : m.admin_connection_http({ status });
        return m.webhook_delivery_http({ status, reason });
    }
    if (!error) return undefined;
    if (error.includes('SSRF guard')) return m.webhook_private_host_help();
    return m.webhook_delivery_failed_help();
}
