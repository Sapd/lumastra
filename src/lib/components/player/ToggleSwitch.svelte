<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        /**
         * ToggleSwitch - A reusable toggle switch component
         *
         * Used in player settings (QualitySelector, TrackSelector)
         * for boolean preferences like auto-play, skip intro, etc.
         */
        active?: boolean;
        ariaLabel?: string;
        disabled?: boolean;
        onclick?: () => void;
    }

    let { active = false, ariaLabel = '', disabled = false, onclick }: Props = $props();
</script>

<button
    class="toggle-switch"
    class:active
    class:disabled
    onclick={() => onclick?.()}
    aria-label={ariaLabel}
    aria-checked={active}
    aria-disabled={disabled}
    role="switch"
    {disabled}>
    <span class="toggle-knob"></span>
</button>

<style>
    .toggle-switch {
        position: relative;
        width: 36px;
        height: 20px;
        background: rgba(255, 255, 255, 0.2);
        border: none;
        border-radius: 10px;
        cursor: pointer;
        transition: background 0.2s ease;
        flex-shrink: 0;
    }

    .toggle-switch.active {
        background: rgba(129, 140, 248, 0.8);
    }

    .toggle-knob {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 16px;
        height: 16px;
        background: white;
        border-radius: 50%;
        transition: transform 0.2s ease;
    }

    .toggle-switch.active .toggle-knob {
        transform: translateX(16px);
    }

    .toggle-switch:focus-visible {
        outline: 2px solid rgba(129, 140, 248, 0.8);
        outline-offset: 2px;
    }

    .toggle-switch.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }
</style>
