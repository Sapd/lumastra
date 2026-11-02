// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

export const CATCHUP_BUDGET_MS = 30 * 60_000;
export const MANUAL_BUDGET_MS = 6 * 60 * 60_000;

/** A normal yield, never a failed detector or a poison-file strike. */
export class AnalysisBudgetReachedError extends Error {
    constructor() {
        super('Intro analysis budget reached; saved work will resume on the next run');
        this.name = 'AnalysisBudgetReachedError';
    }
}
