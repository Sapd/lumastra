// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared run-state badge presets for the admin UI. Used by the
 * `admin/runs` and `admin/task-catalog` components.
 */

import { ExclamationCircle, CheckCircle, QueueList, Pause, Stop, Clock } from 'svelte-hero-icons';
import type { BadgeProps } from './badge-types';

export const RUN_STATE_BADGE = {
    idle: { color: 'gray', label: 'Idle' },
    queued: { color: 'blue', label: 'Queued', icon: QueueList },
    scheduled: { color: 'blue', label: 'Scheduled', icon: Clock },
    running: { color: 'green', label: 'Running', animate: true },
    paused: { color: 'yellow', label: 'Paused', icon: Pause },
    cancelling: {
        color: 'orange',
        label: 'Stopping…',
        icon: Stop,
        animate: true,
    },
    cancelled: { color: 'amber', label: 'Stopped' },
    stalled: { color: 'red', label: 'Stuck' },
    waitingChildren: { color: 'purple', label: 'Waiting' },
    completed: { color: 'green', label: 'Done', icon: CheckCircle },
    /** Raw run failure. */
    failed: { color: 'red', label: 'Failed', icon: ExclamationCircle },
    /** Persistent task-level error state. Distinct from a single failed run. */
    error: { color: 'red', label: 'Error', icon: ExclamationCircle },
} as const satisfies Record<string, BadgeProps>;
