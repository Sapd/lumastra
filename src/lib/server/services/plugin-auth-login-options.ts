// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which auth-provider plugins the pre-auth login page may name.
 *
 * Separate from `plugin-auth.service.ts` on purpose: that module decides who a
 * verified login IS, this one decides what an ANONYMOUS visitor gets told
 * exists. The login page is served to the internet, so its provider list is a
 * disclosure surface — it is derived from the operator's allowlist, never from
 * whatever happens to be installed.
 */

import { config } from '$lib/server/config.js';
import { registry } from '$lib/server/tasks/registry.js';

export interface LoginProviderOption {
    id: string;
    /** Button label. Falls back to the id rather than rendering an empty button. */
    name: string;
    /**
     * Which login shape the page must render: `credentials` reuses the built-in
     * username/password form against a different endpoint, `redirect` is a link
     * that hands the browser to the provider.
     */
    kind: 'credentials' | 'redirect';
}

/**
 * Allowlisted ∩ loaded ∩ actually completable.
 *
 * A provider is only listed when the whole flow for its kind is present. The
 * SDK validator already refuses half a redirect flow at definition time, but a
 * definition reaches the registry by several paths and the pre-auth login page
 * is the wrong place to discover that a button dead-ends — so it is re-checked
 * here rather than assumed.
 *
 * Iterates the ALLOWLIST rather than the registry so the operator's ordering is
 * what the page shows — plugin load order is an implementation detail and would
 * otherwise reshuffle the login page between restarts.
 */
export function listLoginProviders(): LoginProviderOption[] {
    const loaded = new Map(registry.getAllAuthProviders().map((p) => [p.id, p]));
    const out: LoginProviderOption[] = [];
    for (const id of config.AUTH_PLUGIN_PROVIDERS) {
        const def = loaded.get(id);
        if (!def) continue;
        const name = def.name || id;
        if (typeof def.verifyCredentials === 'function') {
            out.push({ id, name, kind: 'credentials' });
        } else if (
            typeof def.beginLogin === 'function' &&
            typeof def.completeLogin === 'function'
        ) {
            out.push({ id, name, kind: 'redirect' });
        }
    }
    return out;
}
