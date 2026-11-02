// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { registerRunFollowup, runTerminalFollowup } from './run-followups.js';

describe('terminal follow-ups', () => {
    it('does nothing for tasks without a registered follow-up or without a database', async () => {
        const followup = vi.fn();
        registerRunFollowup('test-no-database', followup);
        await runTerminalFollowup('test-no-database', null);
        await runTerminalFollowup('test-no-followup', {} as postgres.Sql);
        expect(followup).not.toHaveBeenCalled();
    });

    it('passes the database to the registered follow-up', async () => {
        const followup = vi.fn().mockResolvedValue(undefined);
        const sql = {} as postgres.Sql;
        registerRunFollowup('test-followup', followup);
        await runTerminalFollowup('test-followup', sql);
        expect(followup).toHaveBeenCalledExactlyOnceWith(sql);
    });

    it('never fails a terminal parent when the follow-up rejects', async () => {
        registerRunFollowup('test-failed-followup', async () => {
            throw new Error('queue unavailable');
        });
        await expect(
            runTerminalFollowup('test-failed-followup', {} as postgres.Sql),
        ).resolves.toBeUndefined();
    });
});
