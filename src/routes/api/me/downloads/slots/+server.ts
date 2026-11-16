// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/me/downloads/slots
 * Mounted from: src/lib/server/api/defs/me/downloads/slots.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/me/downloads/slots.js';

export const { GET } = mount(def, { surface: 'internal' });
