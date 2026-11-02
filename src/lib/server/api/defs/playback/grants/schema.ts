// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { PlaybackGrantSchema } from '$lib/schemas/playback-start.js';

export const RenewPlaybackGrantRequestSchema = z.object({ token: z.string().min(1) });

export const GrantIdParams = z.object({ id: z.string().uuid() });

// One grant object for start (`grant` in the start result) and renew; GET omits the secret.
export const RenewPlaybackGrantResponseSchema = PlaybackGrantSchema;
export const PlaybackGrantResponseSchema = PlaybackGrantSchema.omit({ token: true });
