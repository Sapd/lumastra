<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  @component
  Multi-select use-case tiles (setup wizard step 3 and Admin → Instance profile).

  Each tile is a toggle button: `aria-pressed` carries the selected state, which
  colour alone used to signal, so a screen reader heard a plain button with no
  state. Native <button>s keep Enter/Space working; the group gets the section
  heading as its accessible name, and focus-visible draws an outline that stays
  visible on the filled (selected) tile too.
-->
<script lang="ts">
    interface UseCaseOption {
        id: string;
        label: string;
        /** Secondary line under the label. */
        note?: string;
    }

    interface Props {
        options: UseCaseOption[];
        selected: string[];
        ontoggle: (id: string) => void;
        /** id of the heading that names the group. */
        labelledby?: string;
        /** `setup` = wizard cards, `admin` = admin settings rows. */
        appearance?: 'setup' | 'admin';
    }

    let { options, selected, ontoggle, labelledby, appearance = 'setup' }: Props = $props();

    const focusRing =
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-400';

    function tileClass(isSelected: boolean): string {
        if (appearance === 'admin') {
            return `w-full text-left rounded-lg border p-4 transition-colors duration-200 ${
                isSelected
                    ? 'bg-primary-600/20 border-primary-500/60 text-white'
                    : 'bg-surface-800 border-surface-700 text-surface-200 hover:bg-surface-700/60'
            }`;
        }
        return `card w-full p-4 text-left ${isSelected ? 'variant-filled-primary' : 'variant-soft'}`;
    }
</script>

<div class="space-y-3" role="group" aria-labelledby={labelledby}>
    {#each options as opt (opt.id)}
        {@const isSelected = selected.includes(opt.id)}
        <button
            type="button"
            class="{tileClass(isSelected)} {focusRing}"
            aria-pressed={isSelected}
            onclick={() => ontoggle(opt.id)}>
            <span class={appearance === 'admin' ? 'font-semibold' : ''}>{opt.label}</span>
            {#if opt.note}
                <span class="block text-sm text-surface-400 mt-0.5">{opt.note}</span>
            {/if}
        </button>
    {/each}
</div>
