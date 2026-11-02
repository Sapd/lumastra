// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/continue-watching/clear — bulk-clear CW items (SPA surface).
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/continue-watching/clear.js';

export const { POST } = mount(def, { surface: 'internal' });
