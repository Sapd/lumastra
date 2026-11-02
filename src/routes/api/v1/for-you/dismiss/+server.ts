// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST/DELETE /api/v1/for-you/dismiss — for-you item dismissal.
// Auto-generated mount — do not add handler logic here.
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/for-you/dismiss.js';

export const { POST, DELETE } = mount(def, { surface: 'v1' });
