// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/v1/events — unified per-user SSE channel
//
// Provides:
//   - Valkey-backed replay (Last-Event-ID)
//   - Admin/maintenance fan-out
//   - Watch-state change events
//   - Device remote-control events (device.command to the target device only,
//     device.command_status / device.state to the account; via the hub)
//   - Keepalive pings
//
// Definition: $lib/server/api/defs/events/index.ts

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/events/index.js';

export const { GET } = mount(def, { surface: 'v1' });
