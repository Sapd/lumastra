// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Push notification registration schemas.
 *
 * Single source of truth for the device-token registration contract. The iOS
 * client codes against this shape; run `npm run openapi:generate` after changing
 * it.
 *
 * @module schemas/push-notifications
 */

import { z } from 'zod';
import * as m from '$lib/paraglide/messages';

export const PushEnvironmentSchema = z
    .enum(['sandbox', 'production'])
    .describe('APNs environment the token was issued for; must match how the build was signed')
    .meta({ id: 'PushEnvironment' });

export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;

export const PushTokenRegistrationSchema = z
    .object({
        token: z.string().min(1).max(512).describe('APNs device token as delivered to the app'),
        bundleId: z
            .string()
            .min(1)
            .max(256)
            .regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/, { error: () => m.apns_topic_invalid() })
            .describe('Bundle identifier of the registering app, used as the APNs topic'),
        environment: PushEnvironmentSchema,
        locale: z
            .string()
            .max(35)
            .optional()
            .describe(
                "The app's effective locale as a BCP-47 tag (e.g. 'de-DE'). Send the language " +
                    'the app itself is displaying, not the device language, so push text matches ' +
                    'the rest of the UI. Omitted or unsupported falls back to English.',
            ),
        payloadVersion: z
            .number()
            .int()
            .min(1)
            .describe('Highest push payload version this build understands'),
    })
    .meta({
        id: 'PushTokenRegistration',
        description: 'Register or refresh the APNs device token for one device',
    });

export type PushTokenRegistration = z.infer<typeof PushTokenRegistrationSchema>;

export const PushTokenRegistrationResponseSchema = z
    .object({
        deviceSessionId: z.string(),
        deviceId: z.string(),
        environment: PushEnvironmentSchema,
        registered: z.boolean(),
    })
    .meta({
        id: 'PushTokenRegistrationResponse',
        description: 'Result of a push token registration',
    });

export const PushNotificationContentSchema = z
    .object({
        title: z
            .string()
            .describe('Replacement banner title — the series or movie title, already localized'),
        body: z
            .string()
            .describe('Replacement banner body — the episode/availability line, already localized'),
    })
    .meta({
        id: 'PushNotificationContent',
        description:
            'The real, media-naming text for one notification. Fetched by the iOS Notification ' +
            "Service Extension from the user's own server because the push payload itself is " +
            'content-free (it crosses the Lumastra-operated relay).',
    });

export type PushNotificationContent = z.infer<typeof PushNotificationContentSchema>;
