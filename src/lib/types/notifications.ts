// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Types for Request Notification System
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/notifications-types'.
 */

export type {
    DownloadProgress,
    RequestStatus,
    NotificationMediaType,
    RequestNotification,
    SeasonStatus,
    RequestNotificationsState,
} from '$lib/schemas/notifications-types';
