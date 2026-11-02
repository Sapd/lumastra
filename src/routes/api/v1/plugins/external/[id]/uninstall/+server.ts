// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/plugins/external/{id}/uninstall
 * Mounted from: src/lib/server/api/defs/plugins/external/[id]/uninstall.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/plugins/external/[id]/uninstall.js';

export const { POST } = mount(def, { surface: 'v1' });
