// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/renditions/{renditionId}/file
 * Mounted from: src/lib/server/api/defs/renditions/[renditionId]/file.ts
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/renditions/[renditionId]/file.js';

export const { GET } = mount(def, { surface: 'v1' });
