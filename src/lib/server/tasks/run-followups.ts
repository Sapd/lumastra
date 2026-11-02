// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('RunFollowups');
type Followup = (sql: postgres.Sql) => Promise<void>;
const followups = new Map<string, Followup>();

export function registerRunFollowup(taskId: string, followup: Followup): void {
    followups.set(taskId, followup);
}

export async function runTerminalFollowup(taskId: string, sql: postgres.Sql | null): Promise<void> {
    const followup = followups.get(taskId);
    if (!sql || !followup) return;
    try {
        await followup(sql);
    } catch {
        logger.warn('A terminal follow-up could not start', { taskId });
    }
}
