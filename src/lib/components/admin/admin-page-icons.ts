// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Central icon registry for admin pages.
 * Both AdminNav and individual page headers import from here
 * to keep icons consistent and deduplicated.
 */
import {
    Home,
    Film,
    CommandLine,
    BookOpen,
    CpuChip,
    ChartBar,
    CircleStack,
    QueueList,
    Users,
    Key,
    Cog6Tooth,
    Cog8Tooth,
    ServerStack,
    Sparkles,
    PlayCircle,
    Bars3,
    Tv,
    Signal,
    ChartBarSquare,
    Folder,
    Microphone,
    MusicalNote,
    ShieldCheck,
    ShieldExclamation,
    Lifebuoy,
    ArchiveBox,
    GlobeAlt,
    LockClosed,
    CurrencyDollar,
    Heart,
    TableCells,
    MagnifyingGlass,
    Megaphone,
    Beaker,
    BuildingOffice2,
    ClipboardDocumentList,
    PresentationChartBar,
    ArrowUpTray,
    Swatch,
    ExclamationTriangle,
} from 'svelte-hero-icons';
import type { IconSource } from 'svelte-hero-icons';

type AdminRoute =
    | '/admin'
    | '/admin/library'
    | '/admin/library/media'
    | '/admin/library/fix-matches'
    | '/admin/library/quarantine'
    | '/admin/library/sources'
    | '/admin/library/upload'
    | '/admin/library/insights'
    | '/admin/library/segment-stats'
    | '/admin/tasks'
    | '/admin/tasks/runs'
    | '/admin/tasks/pipeline'
    | '/admin/users'
    | '/admin/users/sessions'
    | '/admin/notifications'
    | '/admin/users/activity'
    | '/admin/users/playback-quality'
    | '/admin/users/client-diagnostics'
    | '/admin/users/api-tokens'
    | '/admin/settings'
    | '/admin/settings/playback'
    | '/admin/settings/ai'
    | '/admin/settings/providers'
    | '/admin/settings/connections'
    | '/admin/settings/media'
    | '/admin/settings/tasks'
    | '/admin/settings/music'
    | '/admin/settings/audiobookshelf'
    | '/admin/settings/livetv'
    | '/admin/settings/homepage'
    | '/admin/settings/appearance'
    | '/admin/settings/plugins'
    | '/admin/settings/access'
    | '/admin/settings/secrets'
    | '/admin/settings/webhooks'
    | '/admin/system'
    | '/admin/system/health'
    | '/admin/system/cost'
    | '/admin/system/audit-log'
    | '/admin/system/instance'
    | '/admin/system/transcode-failures'
    | '/admin/system/diagnostics'
    | '/admin/showcase'
    | '/admin/developer/registry'
    | '/admin/developer/reconciliation'
    | '/admin/developer/cache'
    | '/admin/developer/embeddings'
    | '/admin/developer/vod-embeddings'
    | '/admin/developer/sonic-embeddings'
    | '/admin/developer/continue-watching'
    | '/admin/developer/crossfade-lab';

/** Icons keyed by admin route path (without trailing slash) */
export const adminPageIcons: Record<AdminRoute, IconSource> = {
    '/admin': ChartBarSquare,
    '/admin/library': BookOpen,
    '/admin/library/media': Film,
    '/admin/library/fix-matches': MagnifyingGlass,
    '/admin/library/quarantine': ArchiveBox,
    '/admin/library/sources': BookOpen,
    '/admin/library/upload': ArrowUpTray,
    '/admin/library/insights': ChartBar,
    '/admin/library/segment-stats': ChartBar,
    '/admin/tasks': CommandLine,
    '/admin/tasks/runs': QueueList,
    '/admin/tasks/pipeline': Signal,
    '/admin/users': Users,
    '/admin/users/sessions': QueueList,
    '/admin/notifications': Megaphone,
    '/admin/users/activity': ClipboardDocumentList,
    '/admin/users/playback-quality': ChartBar,
    '/admin/users/client-diagnostics': ExclamationTriangle,
    '/admin/users/api-tokens': Key,
    '/admin/settings': Cog6Tooth,
    '/admin/settings/playback': PlayCircle,
    '/admin/settings/ai': Sparkles,
    '/admin/settings/providers': CircleStack,
    '/admin/settings/connections': ServerStack,
    '/admin/settings/media': Folder,
    '/admin/settings/tasks': CpuChip,
    '/admin/settings/music': MusicalNote,
    '/admin/settings/audiobookshelf': BookOpen,
    '/admin/settings/livetv': Tv,
    '/admin/settings/homepage': Home,
    '/admin/settings/appearance': Swatch,
    '/admin/settings/plugins': Cog8Tooth,
    '/admin/settings/access': ShieldCheck,
    '/admin/settings/secrets': LockClosed,
    '/admin/settings/webhooks': GlobeAlt,
    '/admin/system': ServerStack,
    '/admin/system/health': Heart,
    '/admin/system/cost': CurrencyDollar,
    '/admin/system/audit-log': ClipboardDocumentList,
    '/admin/system/instance': BuildingOffice2,
    '/admin/system/transcode-failures': ShieldExclamation,
    '/admin/system/diagnostics': Lifebuoy,
    '/admin/showcase': PresentationChartBar,
    '/admin/developer/registry': TableCells,
    '/admin/developer/reconciliation': ArchiveBox,
    '/admin/developer/cache': CircleStack,
    '/admin/developer/embeddings': CpuChip,
    '/admin/developer/vod-embeddings': Film,
    '/admin/developer/sonic-embeddings': Sparkles,
    '/admin/developer/continue-watching': ShieldCheck,
    '/admin/developer/crossfade-lab': Beaker,
};

// Re-export commonly used icons for pages that also need them for non-header purposes
export {
    Home,
    Film,
    CommandLine,
    BookOpen,
    CpuChip,
    ChartBar,
    CircleStack,
    QueueList,
    Users,
    Key,
    Cog6Tooth,
    Cog8Tooth,
    ServerStack,
    Sparkles,
    PlayCircle,
    Bars3,
    Tv,
    Signal,
    ChartBarSquare,
    Folder,
    Microphone,
    ShieldCheck,
    ShieldExclamation,
    Lifebuoy,
    ArchiveBox,
    GlobeAlt,
    LockClosed,
    CurrencyDollar,
    Heart,
    TableCells,
    Beaker,
    BuildingOffice2,
    ClipboardDocumentList,
    PresentationChartBar,
    ArrowUpTray,
};
