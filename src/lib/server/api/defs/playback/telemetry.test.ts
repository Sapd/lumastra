// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const record = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { recordClientReport: record },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
import { def } from './telemetry.js';
import { publicTelemetryReportSchema } from '$lib/schemas/playback.js';
const playbackSessionId = '00000000-0000-4000-8000-000000000001';
const event = { locals: { user: { userId: 'owner' } } };
beforeEach(() => {
    record.mockReset();
    record.mockResolvedValue(true);
});
describe('telemetry playbackSessionId wire field', () => {
    it('maps the renamed wire field into the existing telemetry service', async () => {
        const body = publicTelemetryReportSchema.parse({
            playbackSessionId,
            clientType: 'avplayer',
            events: [{ type: 'delivery_window', value: 1 }],
        });
        const response = await def.handlers.POST!(event as never, { input: { body } } as never);
        expect(response.status).toBe(204);
        expect(record).toHaveBeenCalledWith(
            expect.objectContaining({ playSessionId: playbackSessionId, clientType: 'native_hls' }),
            'owner',
        );
    });
    it('acknowledges an empty best-effort report without recording it', async () => {
        const response = await def.handlers.POST!(
            event as never,
            { input: { body: { playbackSessionId, events: [] } } } as never,
        );
        expect(response.status).toBe(204);
        expect(record).not.toHaveBeenCalled();
    });
});
