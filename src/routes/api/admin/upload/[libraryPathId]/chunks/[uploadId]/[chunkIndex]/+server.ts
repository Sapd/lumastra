// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT /api/admin/upload/[libraryPathId]/chunks/[uploadId]/[chunkIndex]
 * Contract: bare { received, chunkIndex, chunksReceived }; errors → problem+json.
 */

import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/admin/upload/[libraryPathId]/chunks/[uploadId].js';

export const { PUT } = mount(def, { surface: 'internal' });
