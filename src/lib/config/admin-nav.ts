// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * THE admin navigation manifest (admin IA redesign, spec §4).
 *
 * One source of truth for the admin information architecture: six operator
 * sections + one hidden Developer area, each section a flat list of pages. Both
 * nav renderers (sidebar + mega-menu), the breadcrumb, the section-tab row and
 * the mobile drawer consume this — nothing else defines admin structure.
 *
 * The manifest NEVER computes status. A page's optional `statusKey` is resolved
 * by the renderers against the status-payload store (`adminStatus.payload
 * ?.sectionStatus[...]`, spec §5); here we only declare structure and gating.
 *
 * Every `path` below is a FINAL route (step `sections-routing`, 2026-07-10,
 * completed the last mechanical `git mv`s — no more forward-referenced or
 * not-yet-moved entries remain).
 */

import type { IconSource } from 'svelte-hero-icons';
import {
    Home,
    Film,
    CpuChip,
    ServerStack,
    Users,
    Cog6Tooth,
    CommandLine,
    BookOpen,
    MagnifyingGlass,
    Megaphone,
    CircleStack,
    ArrowUpTray,
    PresentationChartBar,
    ChartBar,
    ExclamationTriangle,
    QueueList,
    Signal,
    Heart,
    CurrencyDollar,
    ClipboardDocumentList,
    BuildingOffice2,
    Key,
    PlayCircle,
    Sparkles,
    Bars3,
    Tv,
    MusicalNote,
    LockClosed,
    GlobeAlt,
    Cog8Tooth,
    Beaker,
    ShieldCheck,
    ShieldExclamation,
    Lifebuoy,
    TableCells,
    Swatch,
    Folder,
    WrenchScrewdriver,
} from 'svelte-hero-icons';
import * as m from '$lib/paraglide/messages.js';
import type { AdminSectionId } from '$lib/schemas/api-admin-status-payload.js';

export type { AdminSectionId };

/** Which enterprise module a page belongs to (all default OFF / unlicensed). */
export type PrivateModule = 'trainingAssignments' | 'assessment' | 'showcase';

/** How the admin nav renders — user preference, live-switchable (spec §4). */
export type AdminNavStyle = 'sidebar' | 'mega';

/** A single navigable admin page. */
export interface AdminNavPage {
    /** Absolute route, e.g. `/admin/tasks/runs`. Unique across the manifest. */
    path: string;
    /** Paraglide message fn (spec's `titleKey`). */
    title: () => string;
    /** One-line page description (≤ ~90 chars, EN & DE), Paraglide message fn. */
    description?: () => string;
    /** Icon shown in both renderers. */
    icon?: IconSource;
    /** Section this page's worst status rolls up into (spec §5 sectionStatus). */
    statusKey?: AdminSectionId;
    /** Developer-only page — hidden unless developer tools are enabled. */
    devOnly?: boolean;
    /** Visible only when the given enterprise module is licensed/enabled. */
    privateModule?: PrivateModule;
    /**
     * Visible only when this key in layout `data.features` is truthy.
     * Keyed to `AppFeatures` so a typo'd flag name fails to compile instead of
     * silently hiding the page forever.
     */
    featureFlag?: keyof NonNullable<App.PageData['features']>;
}

/** A top-level admin section (a column in the mega-menu; a row in the sidebar). */
export interface AdminNavSection {
    id: AdminSectionId;
    title: () => string;
    icon: IconSource;
    /** The whole section is developer-only (spec §3.7). */
    devOnly?: boolean;
    /** Pages in display order; the FIRST page is the section landing. */
    pages: AdminNavPage[];
}

/**
 * The manifest. Order is display order. Section landing = `pages[0]`.
 */
export const ADMIN_NAV: readonly AdminNavSection[] = [
    {
        id: 'home',
        title: m.admin_nav_section_home,
        icon: Home,
        pages: [
            {
                path: '/admin',
                title: m.admin_nav_page_home,
                description: m.admin_nav_desc_home,
                icon: Home,
                statusKey: 'home',
            },
        ],
    },
    {
        id: 'library',
        title: m.admin_nav_section_library,
        icon: Film,
        pages: [
            {
                path: '/admin/library/media',
                title: m.admin_nav_page_library_media,
                description: m.admin_nav_desc_library_media,
                icon: Film,
                statusKey: 'library',
            },
            {
                // NEW page — built in step:fix-matches; 404s until then.
                path: '/admin/library/fix-matches',
                title: m.admin_nav_page_library_fix_matches,
                description: m.admin_nav_desc_library_fix_matches,
                icon: MagnifyingGlass,
                statusKey: 'library',
            },
            {
                path: '/admin/library/sources',
                title: m.admin_nav_page_library_sources,
                description: m.admin_nav_desc_library_sources,
                icon: BookOpen,
                statusKey: 'library',
            },
            {
                path: '/admin/library/upload',
                title: m.admin_nav_page_library_upload,
                description: m.admin_nav_desc_library_upload,
                icon: ArrowUpTray,
                // Only with an enabled home-video/training/educational/personal
                // library — every other type rejects uploads.
                featureFlag: 'libraryUpload',
            },
            {
                path: '/admin/showcase',
                title: m.admin_nav_page_library_showcase,
                description: m.admin_nav_desc_library_showcase,
                icon: PresentationChartBar,
                // Showcase module. Gated by the layout on the showcase master
                // switch (FEATURE_PUBLIC_SHOWCASE, default OFF) → hidden+unbadged by
                // default, shown+badged when the operator turns showcase on.
                privateModule: 'showcase',
            },
            {
                path: '/admin/library/insights',
                title: m.admin_nav_page_library_insights,
                description: m.admin_nav_desc_library_insights,
                icon: ChartBar,
            },
            {
                path: '/admin/library/segment-stats',
                title: m.admin_nav_page_library_segment_stats,
                description: m.admin_nav_desc_library_segment_stats,
                icon: ChartBar,
            },
        ],
    },
    {
        id: 'tasks',
        title: m.admin_nav_section_tasks,
        icon: CpuChip,
        pages: [
            {
                path: '/admin/tasks',
                title: m.admin_nav_page_tasks_overview,
                description: m.admin_nav_desc_tasks_overview,
                icon: CpuChip,
                statusKey: 'tasks',
            },
            {
                path: '/admin/tasks/runs',
                title: m.admin_nav_page_tasks_runs,
                description: m.admin_nav_desc_tasks_runs,
                icon: QueueList,
                statusKey: 'tasks',
            },
            {
                path: '/admin/tasks/pipeline',
                title: m.admin_nav_page_tasks_pipeline,
                description: m.admin_nav_desc_tasks_pipeline,
                icon: Signal,
                statusKey: 'tasks',
            },
        ],
    },
    {
        id: 'system',
        title: m.admin_nav_section_system,
        icon: ServerStack,
        pages: [
            {
                path: '/admin/system/health',
                title: m.admin_nav_page_system_health,
                description: m.admin_nav_desc_system_health,
                icon: Heart,
                statusKey: 'system',
            },
            {
                // The symptom router (`/admin/fix`). Sits directly under Health
                // because the two answer the same question from opposite ends:
                // Health lists what the SERVER thinks is wrong, this starts from
                // what the OPERATOR can see. Its leaf pages
                // (`/admin/fix/<symptom>`) are deliberately NOT listed —
                // `findNavPage` resolves by longest prefix, so they breadcrumb
                // to this entry on their own, and ten more manifest rows would
                // bury every other System page.
                path: '/admin/fix',
                title: m.admin_nav_page_system_fix,
                description: m.admin_nav_desc_system_fix,
                icon: WrenchScrewdriver,
            },
            {
                path: '/admin/system/cost',
                title: m.admin_nav_page_system_cost,
                description: m.admin_nav_desc_system_cost,
                icon: CurrencyDollar,
            },
            {
                path: '/admin/system/audit-log',
                title: m.admin_nav_page_system_audit,
                description: m.admin_nav_desc_system_audit,
                icon: ClipboardDocumentList,
            },
            {
                path: '/admin/system/instance',
                title: m.admin_nav_page_system_instance,
                description: m.admin_nav_desc_system_instance,
                icon: BuildingOffice2,
            },
            {
                path: '/admin/system/transcode-failures',
                title: m.admin_nav_page_system_transcode_failures,
                description: m.admin_nav_desc_system_transcode_failures,
                icon: ShieldExclamation,
            },
            {
                path: '/admin/system/diagnostics',
                title: m.admin_nav_page_system_diagnostics,
                description: m.admin_nav_desc_system_diagnostics,
                icon: Lifebuoy,
            },
        ],
    },
    {
        id: 'users',
        title: m.admin_nav_section_users,
        icon: Users,
        pages: [
            {
                path: '/admin/users',
                title: m.admin_nav_page_users_users,
                description: m.admin_nav_desc_users_users,
                icon: Users,
            },
            {
                path: '/admin/users/sessions',
                title: m.admin_nav_page_users_sessions,
                description: m.admin_nav_desc_users_sessions,
                icon: QueueList,
            },
            {
                // Durable, pinnable announcements to users. Sits next to
                // Sessions because the two are adjacent in an operator's head
                // ("tell people something") while being genuinely different
                // features: Sessions' "Send message" is a perishable toast to
                // live playback, this writes an inbox row that survives the
                // recipient being offline. Neighbours, not duplicates.
                path: '/admin/notifications',
                title: m.admin_nav_page_users_broadcasts,
                description: m.admin_nav_desc_users_broadcasts,
                icon: Megaphone,
            },
            {
                path: '/admin/users/activity',
                title: m.admin_nav_page_users_activity,
                description: m.admin_nav_desc_users_activity,
                icon: ClipboardDocumentList,
            },
            {
                path: '/admin/users/playback-quality',
                title: m.admin_nav_page_users_playback_quality,
                description: m.admin_nav_desc_users_playback_quality,
                icon: ChartBar,
                statusKey: 'users',
            },
            {
                path: '/admin/users/client-diagnostics',
                title: m.admin_nav_page_users_client_diagnostics,
                description: m.admin_nav_desc_users_client_diagnostics,
                icon: ExclamationTriangle,
                statusKey: 'users',
            },
            {
                path: '/admin/users/api-tokens',
                title: m.admin_nav_page_users_api_tokens,
                description: m.admin_nav_desc_users_api_tokens,
                icon: Key,
            },
            {
                path: '/admin/trainings',
                title: m.admin_nav_page_users_trainings,
                description: m.admin_nav_desc_users_trainings,
                icon: BookOpen,
                privateModule: 'trainingAssignments',
            },
            {
                path: '/admin/reporting',
                title: m.admin_nav_page_users_reporting,
                description: m.admin_nav_desc_users_reporting,
                icon: ClipboardDocumentList,
                privateModule: 'trainingAssignments',
            },
            {
                path: '/admin/courses',
                title: m.admin_nav_page_users_courses,
                description: m.admin_nav_desc_users_courses,
                icon: BookOpen,
                privateModule: 'assessment',
            },
            {
                path: '/admin/quizzes',
                title: m.admin_nav_page_users_quizzes,
                description: m.admin_nav_desc_users_quizzes,
                icon: BookOpen,
                privateModule: 'assessment',
            },
        ],
    },
    {
        id: 'settings',
        title: m.admin_nav_section_settings,
        icon: Cog6Tooth,
        pages: [
            {
                path: '/admin/settings',
                title: m.admin_nav_page_settings_general,
                description: m.admin_nav_desc_settings_general,
                icon: Cog6Tooth,
            },
            {
                path: '/admin/settings/playback',
                title: m.admin_nav_page_settings_playback,
                description: m.admin_nav_desc_settings_playback,
                icon: PlayCircle,
            },
            {
                path: '/admin/settings/ai',
                title: m.admin_nav_page_settings_ai,
                description: m.admin_nav_desc_settings_ai,
                icon: Sparkles,
            },
            {
                path: '/admin/settings/connections',
                title: m.admin_nav_page_settings_connections,
                description: m.admin_nav_desc_settings_connections,
                icon: ServerStack,
                statusKey: 'settings',
            },
            {
                path: '/admin/settings/providers',
                title: m.admin_nav_page_settings_providers,
                description: m.admin_nav_desc_settings_providers,
                icon: CircleStack,
            },
            {
                // Image optimization + media storage, split off the general
                // settings page (which rendered 13 sections / ~275 settings).
                path: '/admin/settings/media',
                title: m.admin_nav_page_settings_media,
                description: m.admin_nav_desc_settings_media,
                icon: Folder,
            },
            {
                path: '/admin/settings/music',
                title: m.admin_nav_page_settings_music,
                description: m.admin_nav_desc_settings_music,
                icon: MusicalNote,
            },
            {
                path: '/admin/settings/audiobookshelf',
                title: m.admin_nav_page_settings_audiobookshelf,
                description: m.admin_nav_desc_settings_audiobookshelf,
                icon: BookOpen,
            },
            {
                path: '/admin/settings/livetv',
                title: m.admin_nav_page_settings_livetv,
                description: m.admin_nav_desc_settings_livetv,
                icon: Tv,
                statusKey: 'settings',
            },
            {
                path: '/admin/settings/homepage',
                title: m.admin_nav_page_settings_homepage,
                description: m.admin_nav_desc_settings_homepage,
                icon: Bars3,
            },
            {
                // Theming engine: default theme + custom theme editor + custom
                // CSS/JS injection. No dedicated admin_nav_page_settings_appearance
                // i18n key exists yet, so this reuses the panel's own heading/
                // description keys (admin_appearance_title/_description) rather
                // than adding new ones (messages/*.json is off-limits for this
                // change — see the panel's own doc comment).
                path: '/admin/settings/appearance',
                title: m.admin_appearance_title,
                description: m.admin_appearance_description,
                icon: Swatch,
            },
            {
                path: '/admin/settings/plugins',
                title: m.admin_nav_page_settings_plugins,
                description: m.admin_nav_desc_settings_plugins,
                icon: Cog8Tooth,
            },
            {
                // Task-runner tuning and per-task killswitches (the `advanced-tasks`
                // section). The operator screens it governs are under /admin/tasks.
                path: '/admin/settings/tasks',
                title: m.admin_nav_page_settings_tasks,
                description: m.admin_nav_desc_settings_tasks,
                icon: CpuChip,
            },
            {
                path: '/admin/settings/access',
                title: m.admin_nav_page_settings_access,
                description: m.admin_nav_desc_settings_access,
                icon: ShieldCheck,
            },
            {
                path: '/admin/settings/secrets',
                title: m.admin_nav_page_settings_secrets,
                description: m.admin_nav_desc_settings_secrets,
                icon: LockClosed,
            },
            {
                path: '/admin/settings/webhooks',
                title: m.admin_nav_page_settings_webhooks,
                description: m.admin_nav_desc_settings_webhooks,
                icon: GlobeAlt,
            },
        ],
    },
    {
        id: 'developer',
        title: m.admin_nav_section_developer,
        icon: CommandLine,
        devOnly: true,
        pages: [
            {
                // Final path (step:developer-area). The raw, complete registry
                // dump absorbs what used to be operations/extensions' plugin
                // cards (feature/sync/watch-sync/external) AND providers' old
                // "Library & Integration Services" section — there is no
                // separate Developer "Plugins" page (see this step's progress
                // log entry: Settings → Plugins & features already owns the
                // reload/install/validation workflow as an operator page, so a
                // second raw plugin list here would violate "registry renders
                // once").
                path: '/admin/developer/registry',
                title: m.admin_nav_page_developer_registry,
                description: m.admin_nav_desc_developer_registry,
                icon: TableCells,
                devOnly: true,
            },
            {
                // Final path (step:developer-area).
                path: '/admin/developer/cache',
                title: m.admin_nav_page_developer_cache,
                description: m.admin_nav_desc_developer_cache,
                icon: CircleStack,
                devOnly: true,
            },
            {
                // Final path (step:developer-area). Ex media-browser
                // Quarantine tab, rebuilt as its own page.
                path: '/admin/developer/reconciliation',
                title: m.admin_nav_page_developer_reconciliation,
                description: m.admin_nav_desc_developer_reconciliation,
                icon: TableCells,
                devOnly: true,
            },
            {
                // Final path (step:developer-area). Was unreachable from any
                // nav before this step (`/admin/audit` had no nav entry).
                path: '/admin/developer/continue-watching',
                title: m.admin_nav_page_developer_continue_watching,
                description: m.admin_nav_desc_developer_continue_watching,
                icon: ShieldCheck,
                devOnly: true,
            },
            {
                // Final path (step:developer-area).
                path: '/admin/developer/embeddings',
                title: m.admin_nav_page_developer_embeddings,
                description: m.admin_nav_desc_developer_embeddings,
                icon: CpuChip,
                devOnly: true,
            },
            {
                // Final path (step:developer-area).
                path: '/admin/developer/vod-embeddings',
                title: m.admin_nav_page_developer_vod_embeddings,
                description: m.admin_nav_desc_developer_vod_embeddings,
                icon: Film,
                devOnly: true,
            },
            {
                // Final path (step:developer-area).
                path: '/admin/developer/sonic-embeddings',
                title: m.admin_nav_page_developer_sonic_embeddings,
                description: m.admin_nav_desc_developer_sonic_embeddings,
                icon: Sparkles,
                devOnly: true,
            },
            {
                // Final path (step:developer-area).
                path: '/admin/developer/crossfade-lab',
                title: m.admin_nav_page_developer_crossfade_lab,
                description: m.admin_nav_desc_developer_crossfade_lab,
                icon: Beaker,
                devOnly: true,
            },
        ],
    },
];

/** Runtime gating inputs for {@link visibleNav}. */
export interface NavGateContext {
    /** Developer tools toggle (Settings → General → "Show developer tools"). */
    devToolsEnabled: boolean;
    /** Layout `data.features` — the SSR feature matrix. */
    features: NonNullable<App.PageData['features']>;
    /** Training-assignments module enabled. */
    trainingAssignments: boolean;
    /** Assessment (courses/quizzes) module enabled. */
    assessment: boolean;
    /** Product-showcase module enabled. */
    showcase: boolean;
}

/** The gating fields shared by nav pages and search metadata. */
export interface NavGatePermission {
    devOnly?: boolean;
    privateModule?: PrivateModule;
    featureFlag?: keyof NonNullable<App.PageData['features']>;
}

function privateModuleOpen(module: PrivateModule, ctx: NavGateContext): boolean {
    switch (module) {
        case 'trainingAssignments':
            return ctx.trainingAssignments;
        case 'assessment':
            return ctx.assessment;
        case 'showcase':
            return ctx.showcase;
        default: {
            // A new PrivateModule fails to compile here until it is handled.
            void (module satisfies never);
            return false;
        }
    }
}

/**
 * THE gate predicate: true when something with these gating fields (a nav
 * page, a search-meta page or tab) may be opened in `ctx`. No fields = open.
 */
export function isGateOpen(
    permission: NavGatePermission | undefined,
    ctx: NavGateContext,
): boolean {
    if (!permission) return true;
    if (permission.devOnly && !ctx.devToolsEnabled) return false;
    if (permission.privateModule && !privateModuleOpen(permission.privateModule, ctx)) {
        return false;
    }
    if (permission.featureFlag && !ctx.features[permission.featureFlag]) return false;
    return true;
}

/** True when a page passes every gate in `ctx`. */
function pageVisible(page: AdminNavPage, ctx: NavGateContext): boolean {
    return isGateOpen(page, ctx);
}

/**
 * The manifest filtered for the current context: drops dev sections/pages when
 * dev tools are off, enterprise pages when their module is off, feature-flagged
 * pages when their flag is off. Sections with no visible pages are dropped.
 * Pure — unit-tested.
 */
export function visibleNav(ctx: NavGateContext): AdminNavSection[] {
    const out: AdminNavSection[] = [];
    for (const section of ADMIN_NAV) {
        if (section.devOnly && !ctx.devToolsEnabled) continue;
        const pages = section.pages.filter((p) => pageVisible(p, ctx));
        if (pages.length === 0) continue;
        out.push({ ...section, pages });
    }
    return out;
}

/**
 * Resolve a pathname to its owning section + page. Chooses the entry whose
 * `path` is the longest prefix match, so `/admin/tasks/xyz` (a task detail)
 * resolves to the Overview page, `/admin/tasks/runs` resolves to its own
 * Runs entry (longer match wins over the `/admin/tasks` prefix), and
 * `/admin/system/health#findings` resolves to Health. `/admin` matches only
 * exactly (it is a prefix of everything).
 */
export function findNavPage(
    pathname: string,
): { section: AdminNavSection; page: AdminNavPage } | null {
    let best: { section: AdminNavSection; page: AdminNavPage } | null = null;
    let bestLen = -1;
    for (const section of ADMIN_NAV) {
        for (const page of section.pages) {
            const isMatch =
                page.path === '/admin'
                    ? pathname === '/admin'
                    : pathname === page.path || pathname.startsWith(page.path + '/');
            if (isMatch && page.path.length > bestLen) {
                best = { section, page };
                bestLen = page.path.length;
            }
        }
    }
    return best;
}

/** Every page path in the manifest (for tests / uniqueness checks). */
export function allNavPaths(): string[] {
    return ADMIN_NAV.flatMap((s) => s.pages.map((p) => p.path));
}

/**
 * Every page path in the manifest as a `Set` (admin IA legacy-path handling,
 * `src/lib/config/admin-legacy-paths.ts`): used to tell "currently valid admin
 * path" apart from "stale pinned/bookmarked path" without a linear scan.
 */
export function getAllAdminNavPaths(): Set<string> {
    return new Set(allNavPaths());
}
