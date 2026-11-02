// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getContext } from 'svelte';
import type { LiveTvAvailability } from '$lib/schemas/livetv-availability.js';
export const LIVE_TV_AVAILABILITY_CONTEXT = Symbol('Live TV availability');
export function getAvailabilityContext(): (() => LiveTvAvailability | undefined) | undefined {
    return getContext(LIVE_TV_AVAILABILITY_CONTEXT);
}
