// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Type declarations for @event-calendar modules
declare module '@event-calendar/core' {
    export default class Calendar {
        constructor(options: Record<string, unknown>);
        destroy(): void;
        updateOptions(options: Record<string, unknown>): void;
    }
}

declare module '@event-calendar/time-grid' {
    const TimeGrid: unknown;
    export default TimeGrid;
}

declare module '@event-calendar/day-grid' {
    const DayGrid: unknown;
    export default DayGrid;
}

declare module '@event-calendar/list' {
    const List: unknown;
    export default List;
}

declare module '@event-calendar/resource-time-grid' {
    const ResourceTimeGrid: unknown;
    export default ResourceTimeGrid;
}
