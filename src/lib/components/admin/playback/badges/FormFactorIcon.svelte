<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        DevicePhoneMobile,
        DeviceTablet,
        Tv,
        ComputerDesktop,
        QuestionMarkCircle,
    } from 'svelte-hero-icons';
    import { toFormFactor, getFormFactorColor } from '$lib/utils/admin/playback-formatters';

    interface Props {
        /** Device class from the analytics queries (mobile/tablet/tv/desktop/unknown). */
        formFactor: string | null | undefined;
        class?: string;
    }

    let { formFactor, class: className = 'w-4 h-4' }: Props = $props();

    const ICONS = {
        mobile: DevicePhoneMobile,
        tablet: DeviceTablet,
        tv: Tv,
        desktop: ComputerDesktop,
        unknown: QuestionMarkCircle,
    };

    let key = $derived(toFormFactor(formFactor));
</script>

<Icon
    src={ICONS[key]}
    class="{className} shrink-0 {getFormFactorColor(key).text}"
    aria-hidden="true" />
