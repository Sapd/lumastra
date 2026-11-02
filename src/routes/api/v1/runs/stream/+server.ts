// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Thin mount of the shared `runs/stream` SSE def onto the v1 token surface.
// Behaviour is identical to the former bespoke handler — the logic now lives in
// the dual-mountable def so the same endpoint is also served at /api/runs/stream.
//
// The test-only helpers (`_prepareFrame`, `_metaCloudEventType`,
// `_prepareProgressFrame`, `_consumersForTest`, `_broadcastToConsumersForTest`)
// and the `Consumer` type are re-exported here so existing unit tests that
// import them from `./+server.js` keep working unchanged.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/runs/stream.js';

export {
    _prepareFrame,
    _metaCloudEventType,
    _prepareProgressFrame,
    _consumersForTest,
    _broadcastToConsumersForTest,
} from '$lib/server/api/defs/runs/stream.js';
export type { Consumer, ChannelClass, PreparedFrame } from '$lib/server/api/defs/runs/stream.js';

export const { GET } = mount(def, { surface: 'v1' });
