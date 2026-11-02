// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Internal (forward-auth/session) mount for the web UI: /api/v1/* is Bearer-only.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/devices/[id]/commands/index.js';
export const { GET, POST } = mount(def, { surface: 'internal' });
