<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Optional per-language labels for an admin-configured navigation item.

  The plain label stays the fallback; each field here overrides it for viewers
  using that language (see $lib/shared/localized-label). Collapsed unless a
  translation already exists, so the common single-language setup sees nothing
  new.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { locales } from '$lib/paraglide/runtime.js';
    import type { LocalizedLabels } from '$lib/shared/localized-label';

    interface Props {
        labels?: LocalizedLabels;
        /** The plain label, shown as each field's placeholder. */
        fallback: string;
        idPrefix: string;
        onchange: (labels: LocalizedLabels) => void;
    }
    let { labels = {}, fallback, idPrefix, onchange }: Props = $props();

    const hasAny = $derived(Object.values(labels).some((v) => !!v?.trim()));

    function languageName(locale: string): string {
        try {
            const name = new Intl.DisplayNames([locale], { type: 'language' }).of(locale);
            return name ? name.charAt(0).toUpperCase() + name.slice(1) : locale;
        } catch {
            return locale;
        }
    }
</script>

<details class="group" open={hasAny}>
    <summary class="cursor-pointer text-hint select-none">
        {m.admin_navigation_translations()}
        {#if hasAny}
            <span class="text-surface-400"
                >({Object.values(labels).filter((v) => !!v?.trim()).length})</span>
        {/if}
    </summary>
    <p class="text-xs text-surface-400 mt-1 mb-2">{m.admin_navigation_translations_hint()}</p>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {#each locales as locale (locale)}
            <div>
                <label for="{idPrefix}-{locale}" class="block text-hint mb-1"
                    >{languageName(locale)}</label>
                <input
                    id="{idPrefix}-{locale}"
                    type="text"
                    lang={locale}
                    value={labels[locale] ?? ''}
                    placeholder={fallback}
                    oninput={(e) => onchange({ ...labels, [locale]: e.currentTarget.value })}
                    class="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 focus:ring-2 focus:ring-cyan-500 focus:border-transparent" />
            </div>
        {/each}
    </div>
</details>
