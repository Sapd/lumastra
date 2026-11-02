<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // "Now" with a progress bar and "Then" for one channel. Renders nothing
    // when the channel has no guide: no "No information" text.
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { progressPercent, type NowNext } from './simple-lineup.js';

    interface Props {
        info: NowNext;
        now: number;
        /** Show the "Then" line. */
        showNext?: boolean;
    }

    let { info, now, showNext = true }: Props = $props();

    function time(iso: string): string {
        return new Date(iso).toLocaleTimeString(getLocale(), {
            hour: '2-digit',
            minute: '2-digit',
        });
    }
</script>

{#if info.now}
    <div class="row">
        <span class="label">{m.livetv_simple_now()}</span>
        <span class="title">{info.now.title}</span>
    </div>
    <div class="bar" aria-hidden="true">
        <span style:width="{progressPercent(info.now, now)}%"></span>
    </div>
    <p class="until">{m.livetv_simple_until({ time: time(info.now.endTime) })}</p>
{/if}
{#if showNext && info.next}
    <div class="row next">
        <span class="label">{m.livetv_simple_then({ time: time(info.next.startTime) })}</span>
        <span class="title">{info.next.title}</span>
    </div>
{/if}

<style>
    .row {
        display: flex;
        flex-direction: column;
        gap: 0.1em;
    }
    .label {
        font-size: 0.75em;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #fde68a;
    }
    .title {
        font-size: 1em;
        font-weight: 700;
        color: #fff;
        overflow-wrap: anywhere;
    }
    .next {
        margin-top: 0.6em;
    }
    .next .label {
        color: #d1d5db;
    }
    .next .title {
        color: #e5e7eb;
        font-weight: 600;
    }
    .bar {
        margin-top: 0.4em;
        height: 0.4em;
        border-radius: 999px;
        background: rgb(255 255 255 / 0.25);
        overflow: hidden;
    }
    .bar span {
        display: block;
        height: 100%;
        background: #fde68a;
    }
    .until {
        margin-top: 0.25em;
        font-size: 0.7em;
        color: #d1d5db;
    }
</style>
