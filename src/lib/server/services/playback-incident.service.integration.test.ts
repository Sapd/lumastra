// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { recordPlaybackIncident, resolvePlaybackIncident } from './playback-incident.service.js';
import {
    listPlaybackIncidents,
    getPlaybackIncidentById,
    listRecentIncidentFailures,
} from '$lib/server/database/queries/playback-incident-events.queries.js';

let sql: postgres.Sql;
let userId: string;

describe('playback incidents over client_diagnostics', () => {
    beforeAll(async () => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE client_diagnostics CASCADE`;
        await sql`TRUNCATE playback_incident_events`;
        const [u] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${`inc-${randomUUID()}`}) RETURNING id`;
        userId = u.id;
    });

    it('legacy report lands in client_diagnostics, not the legacy table, and reads back in the legacy shape', async () => {
        const incidentAt = Date.now() - 5_000;
        await recordPlaybackIncident(sql, userId, {
            attemptId: 'att-x',
            playSessionId: '',
            incidentAt,
            triggerType: 'error',
            errorType: 'network',
            stage: 'manifest',
            httpStatus: 502,
            message: 'failed ?api_key=SECRET',
            timeline: [{ t: 1 }],
            deviceId: 'dev-9',
        });
        const [{ n: legacy }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM playback_incident_events`;
        expect(legacy).toBe(0);
        const [{ kind }] = await sql<{ kind: string }[]>`SELECT kind FROM client_diagnostics`;
        expect(kind).toBe('playback_incident');

        const { rows, total } = await listPlaybackIncidents(sql, { userId, limit: 10, offset: 0 });
        expect(total).toBe(1);
        const r = rows[0];
        expect(r.attempt_id).toBe('att-x');
        expect(r.trigger_type).toBe('error');
        expect(r.http_status).toBe(502);
        expect(r.incident_at.getTime()).toBe(incidentAt);
        expect(r.occurred_at.getTime()).toBeGreaterThanOrEqual(incidentAt); // server receipt
        expect(r.message).not.toContain('SECRET');
        expect(r.timeline).toEqual([{ t: 1 }]);
        expect(r.device_id).toBe('dev-9');

        const one = await getPlaybackIncidentById(sql, r.id);
        expect(one?.attempt_id).toBe('att-x');
        expect((await listRecentIncidentFailures(sql, 5))[0].trigger_type).toBe('error');
    });

    it('resolve marks only this user’s rows for the attempt', async () => {
        const [other] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${`inc-o-${randomUUID()}`}) RETURNING id`;
        const input = {
            attemptId: 'shared',
            playSessionId: 's',
            incidentAt: Date.now(),
            triggerType: 'terminal' as const,
            timeline: [],
            deviceId: null,
        };
        await recordPlaybackIncident(sql, userId, input);
        await recordPlaybackIncident(sql, other.id, input);
        await resolvePlaybackIncident(sql, userId, { attemptId: 'shared' });
        const rows = await sql<
            { user_id: string; resolved_at: Date | null }[]
        >`SELECT user_id, resolved_at FROM client_diagnostics`;
        expect(rows.find((x) => x.user_id === userId)?.resolved_at).not.toBeNull();
        expect(rows.find((x) => x.user_id === other.id)?.resolved_at).toBeNull();
    });
});
