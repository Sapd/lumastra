// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// DELETE /api/continue-watching/[itemId] — clear single CW item (SPA surface).
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/continue-watching/item.js';

export const { DELETE } = mount(def, { surface: 'internal' });
