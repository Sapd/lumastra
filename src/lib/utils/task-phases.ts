// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const TASK_PHASES = [
    'idle',
    'queued', // Job is waiting in queue
    'waiting', // Job is scheduled to run later
    'delayed', // Job has delayed start time
    'paused', // Job is paused
    'initializing',
    'fetching',
    'filtering',
    'generating',
    'cancelling', // Job is being cancelled, cleanup in progress
    'completed',
    'error',
    'aborted',
] as const;

export type TaskPhase = (typeof TASK_PHASES)[number];

export const TASK_TERMINAL_PHASES = new Set<TaskPhase>(['completed', 'error', 'aborted']);

export const isTaskPhase = (phase: unknown): phase is TaskPhase =>
    typeof phase === 'string' && (TASK_PHASES as readonly string[]).includes(phase);

export const isTerminalPhase = (phase: unknown): boolean =>
    isTaskPhase(phase) && TASK_TERMINAL_PHASES.has(phase);
