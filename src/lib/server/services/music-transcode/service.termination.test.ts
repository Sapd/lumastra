// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => new Map<string, (message: string) => void>());
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => null,
    subscribeToChannel: vi.fn(async (channel: string, handler: (message: string) => void) => {
        handlers.set(channel, handler);
        return () => undefined;
    }),
}));
import { MusicTranscodeService, _setServiceForTests, _resetServiceForTests } from './service.js';

afterEach(() => {
    _resetServiceForTests();
});

describe('music delivery cancellation across replicas', () => {
    it.each(['play-sessions:kill', 'play-sessions:terminated'])(
        'cancels all streams of a session on %s',
        (channel) => {
            // Inject the service so this test exercises the real subscription callback
            // without opening a cache directory or spawning FFmpeg.
            const service = new MusicTranscodeService({ sql: {} as never, cache: {} as never });
            const cancel = vi.spyOn(service, 'cancel').mockReturnValue(true);
            _setServiceForTests(service);
            const handler = handlers.get(channel);
            expect(handler).toBeTypeOf('function');
            handler!(JSON.stringify({ session_id: 'prepared-track', reason: 'superseded' }));
            expect(cancel).toHaveBeenCalledWith('prepared-track');
        },
    );
});
