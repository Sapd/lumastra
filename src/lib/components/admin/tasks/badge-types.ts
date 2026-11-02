// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Shared badge prop shape — consumed by run-state-badges.ts presets and by
// TaskStatusBadge.svelte (which expects these props at the call site).
import type { IconSource } from 'svelte-hero-icons';

export interface BadgeProps {
    color: string;
    label: string;
    icon?: IconSource;
    sublabel?: string;
    animate?: boolean;
    tooltip?: string;
}
