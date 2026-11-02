// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Only event types with production outbox delivery wiring belong here. */
export const WEBHOOK_EVENTS = [
    {
        type: 'org.lumastra.task.run.started',
        label: 'Task run started',
        description: 'A task run started.',
    },
    {
        type: 'org.lumastra.task.run.completed',
        label: 'Task run completed',
        description: 'A task run completed.',
    },
    {
        type: 'org.lumastra.task.run.failed',
        label: 'Task run failed',
        description: 'A task run failed.',
    },
    {
        type: 'org.lumastra.task.run.cancelled',
        label: 'Task run cancelled',
        description: 'A task run was cancelled.',
    },
    {
        type: 'org.lumastra.media.item.added',
        label: 'Media items added',
        description: 'A batch of media items was added.',
    },
    {
        type: 'org.lumastra.user.notification',
        label: 'User notifications',
        description: 'A user notification was forwarded to this webhook.',
    },
] as const;

export const WEBHOOK_EVENT_TYPES = WEBHOOK_EVENTS.map((event) => event.type);
