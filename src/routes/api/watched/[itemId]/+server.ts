// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET/POST/DELETE /api/watched/[itemId] — per-item watched state (SPA surface).
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/watched/item.js';

export const { GET, POST, DELETE } = mount(def, { surface: 'internal' });
