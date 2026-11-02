// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Icon Map for Server-Driven UI
 *
 * Maps string icon names to svelte-hero-icons components.
 * This allows the server to specify icons by name without
 * the client needing to know the exact component references.
 */

import {
    Play,
    PlayCircle,
    Pause,
    Stop,
    Forward,
    Backward,
    ArrowPath,
    ArrowRight,
    ArrowLeft,
    ArrowUp,
    ArrowDown,
    ChevronDown,
    ChevronUp,
    ChevronLeft,
    ChevronRight,
    XMark,
    Plus,
    Minus,
    Check,
    CheckCircle,
    XCircle,
    ExclamationCircle,
    ExclamationTriangle,
    InformationCircle,
    QuestionMarkCircle,
    Fire,
    Sparkles,
    Star,
    Heart,
    Bookmark,
    BookmarkSlash,
    Clock,
    Calendar,
    CalendarDays,
    Film,
    Tv,
    MusicalNote,
    BookOpen,
    MagnifyingGlass,
    Cog6Tooth,
    AdjustmentsHorizontal,
    Bars3,
    EllipsisHorizontal,
    EllipsisVertical,
    Squares2x2,
    QueueList,
    ListBullet,
    Home,
    User,
    UserCircle,
    UserGroup,
    Users,
    Eye,
    EyeSlash,
    LockClosed,
    LockOpen,
    Key,
    Share,
    Link,
    PaperClip,
    CloudArrowDown,
    CloudArrowUp,
    ArrowDownTray,
    ArrowUpTray,
    Trash,
    PencilSquare,
    DocumentText,
    Photo,
    GlobeAlt,
    Signal,
    Wifi,
    ComputerDesktop,
    DevicePhoneMobile,
    DeviceTablet,
    SpeakerWave,
    SpeakerXMark,
    Microphone,
    VideoCamera,
    Camera,
    Sun,
    Moon,
    BoltSlash,
    Bolt,
    Battery0,
    Battery50,
    Battery100,
    ChartBar,
    ChartPie,
    PresentationChartLine,
    ArrowTrendingUp,
    ArrowTrendingDown,
    CurrencyDollar,
    ShoppingCart,
    ShoppingBag,
    Gift,
    GiftTop,
    Cake,
    FaceSmile,
    FaceFrown,
    HandThumbUp,
    HandThumbDown,
    ChatBubbleLeft,
    ChatBubbleLeftRight,
    EnvelopeOpen,
    Envelope,
    Bell,
    BellAlert,
    BellSlash,
    Megaphone,
    Flag,
    Tag,
    Hashtag,
    AtSymbol,
    Funnel,
    AdjustmentsVertical,
    ArrowsPointingOut,
    ArrowsPointingIn,
    ViewColumns,
    RectangleStack,
    Square3Stack3d,
    Cube,
    CubeTransparent,
    Beaker,
    LightBulb,
    RocketLaunch,
    PuzzlePiece,
    CommandLine,
    CodeBracket,
    CircleStack,
    ServerStack,
    CpuChip,
    WrenchScrewdriver,
    Wrench,
    BuildingOffice,
    BuildingLibrary,
    AcademicCap,
    Trophy,
    ShieldCheck,
    ShieldExclamation,
    FingerPrint,
    Identification,
    NoSymbol,
    MinusCircle,
    PlusCircle,
    ArrowPathRoundedSquare,
    ArrowUturnLeft,
    ArrowUturnRight,
    ArrowTopRightOnSquare,
    ArrowRightOnRectangle,
    ArrowLeftOnRectangle,
    QrCode,
    Bars4,
    Bars2,
    StopCircle,
    PlayPause,
    SpeakerWave as VolumeUp,
    SpeakerXMark as VolumeMute,
} from 'svelte-hero-icons';

import type { IconSource } from 'svelte-hero-icons';

/**
 * Icon registry mapping string names to svelte-hero-icons components
 */
const iconRegistry: Record<string, IconSource> = {
    // Playback controls
    play: Play,
    'play-circle': PlayCircle,
    pause: Pause,
    stop: Stop,
    'stop-circle': StopCircle,
    forward: Forward,
    backward: Backward,
    'play-pause': PlayPause,

    // Navigation arrows
    'arrow-path': ArrowPath,
    refresh: ArrowPath,
    'arrow-right': ArrowRight,
    'arrow-left': ArrowLeft,
    'arrow-up': ArrowUp,
    'arrow-down': ArrowDown,
    'chevron-down': ChevronDown,
    'chevron-up': ChevronUp,
    'chevron-left': ChevronLeft,
    'chevron-right': ChevronRight,
    'arrow-top-right': ArrowTopRightOnSquare,
    'external-link': ArrowTopRightOnSquare,

    // Actions
    close: XMark,
    'x-mark': XMark,
    x: XMark,
    plus: Plus,
    add: Plus,
    minus: Minus,
    check: Check,
    'check-circle': CheckCircle,
    'x-circle': XCircle,
    trash: Trash,
    delete: Trash,
    edit: PencilSquare,
    pencil: PencilSquare,

    // Status indicators
    'exclamation-circle': ExclamationCircle,
    error: ExclamationCircle,
    'exclamation-triangle': ExclamationTriangle,
    warning: ExclamationTriangle,
    'information-circle': InformationCircle,
    info: InformationCircle,
    'question-mark-circle': QuestionMarkCircle,
    help: QuestionMarkCircle,

    // Media/Entertainment
    fire: Fire,
    trending: Fire,
    sparkles: Sparkles,
    ai: Sparkles,
    star: Star,
    rating: Star,
    heart: Heart,
    favorite: Heart,
    bookmark: Bookmark,
    'bookmark-slash': BookmarkSlash,
    clock: Clock,
    time: Clock,
    calendar: Calendar,
    'calendar-days': CalendarDays,
    film: Film,
    movie: Film,
    tv: Tv,
    series: Tv,
    music: MusicalNote,
    'musical-note': MusicalNote,
    book: BookOpen,
    'book-open': BookOpen,

    // Search & Settings
    search: MagnifyingGlass,
    'magnifying-glass': MagnifyingGlass,
    settings: Cog6Tooth,
    cog: Cog6Tooth,
    'cog-6-tooth': Cog6Tooth,
    adjustments: AdjustmentsHorizontal,
    'adjustments-horizontal': AdjustmentsHorizontal,
    'adjustments-vertical': AdjustmentsVertical,
    filter: Funnel,
    funnel: Funnel,

    // Layout
    menu: Bars3,
    'bars-3': Bars3,
    'bars-4': Bars4,
    'bars-2': Bars2,
    'ellipsis-horizontal': EllipsisHorizontal,
    'more-horizontal': EllipsisHorizontal,
    'ellipsis-vertical': EllipsisVertical,
    'more-vertical': EllipsisVertical,
    grid: Squares2x2,
    'squares-2x2': Squares2x2,
    list: QueueList,
    'queue-list': QueueList,
    'list-bullet': ListBullet,
    columns: ViewColumns,
    'view-columns': ViewColumns,
    stack: RectangleStack,
    'rectangle-stack': RectangleStack,

    // Navigation
    home: Home,

    // Users
    user: User,
    'user-circle': UserCircle,
    'user-group': UserGroup,
    users: Users,

    // Visibility
    eye: Eye,
    visible: Eye,
    'eye-slash': EyeSlash,
    hidden: EyeSlash,

    // Security
    lock: LockClosed,
    'lock-closed': LockClosed,
    'lock-open': LockOpen,
    unlock: LockOpen,
    key: Key,
    shield: ShieldCheck,
    'shield-check': ShieldCheck,
    'shield-exclamation': ShieldExclamation,
    fingerprint: FingerPrint,
    'finger-print': FingerPrint,
    id: Identification,
    identification: Identification,

    // Sharing
    share: Share,
    link: Link,
    'paper-clip': PaperClip,
    attachment: PaperClip,

    // Download/Upload
    download: ArrowDownTray,
    'arrow-down-tray': ArrowDownTray,
    'cloud-download': CloudArrowDown,
    'cloud-arrow-down': CloudArrowDown,
    upload: ArrowUpTray,
    'arrow-up-tray': ArrowUpTray,
    'cloud-upload': CloudArrowUp,
    'cloud-arrow-up': CloudArrowUp,

    // Documents
    document: DocumentText,
    'document-text': DocumentText,
    photo: Photo,
    image: Photo,

    // Network
    globe: GlobeAlt,
    'globe-alt': GlobeAlt,
    signal: Signal,
    wifi: Wifi,

    // Devices
    desktop: ComputerDesktop,
    'computer-desktop': ComputerDesktop,
    phone: DevicePhoneMobile,
    'device-phone-mobile': DevicePhoneMobile,
    tablet: DeviceTablet,
    'device-tablet': DeviceTablet,

    // Audio
    'speaker-wave': SpeakerWave,
    'volume-up': VolumeUp,
    volume: SpeakerWave,
    'speaker-x-mark': SpeakerXMark,
    'volume-mute': VolumeMute,
    mute: SpeakerXMark,
    microphone: Microphone,
    mic: Microphone,

    // Video
    'video-camera': VideoCamera,
    video: VideoCamera,
    camera: Camera,

    // Theme
    sun: Sun,
    light: Sun,
    moon: Moon,
    dark: Moon,

    // Power
    bolt: Bolt,
    lightning: Bolt,
    'bolt-slash': BoltSlash,
    'battery-0': Battery0,
    'battery-empty': Battery0,
    'battery-50': Battery50,
    'battery-half': Battery50,
    'battery-100': Battery100,
    'battery-full': Battery100,

    // Charts
    'chart-bar': ChartBar,
    chart: ChartBar,
    'chart-pie': ChartPie,
    pie: ChartPie,
    'presentation-chart-line': PresentationChartLine,
    analytics: PresentationChartLine,
    'trending-up': ArrowTrendingUp,
    'arrow-trending-up': ArrowTrendingUp,
    'trending-down': ArrowTrendingDown,
    'arrow-trending-down': ArrowTrendingDown,

    // Commerce
    dollar: CurrencyDollar,
    'currency-dollar': CurrencyDollar,
    cart: ShoppingCart,
    'shopping-cart': ShoppingCart,
    bag: ShoppingBag,
    'shopping-bag': ShoppingBag,

    // Gifts & Celebrations
    gift: Gift,
    'gift-top': GiftTop,
    present: GiftTop,
    cake: Cake,
    birthday: Cake,

    // Reactions
    smile: FaceSmile,
    'face-smile': FaceSmile,
    happy: FaceSmile,
    frown: FaceFrown,
    'face-frown': FaceFrown,
    sad: FaceFrown,
    'thumb-up': HandThumbUp,
    'hand-thumb-up': HandThumbUp,
    like: HandThumbUp,
    'thumb-down': HandThumbDown,
    'hand-thumb-down': HandThumbDown,
    dislike: HandThumbDown,

    // Communication
    chat: ChatBubbleLeft,
    'chat-bubble-left': ChatBubbleLeft,
    'chat-bubble-left-right': ChatBubbleLeftRight,
    conversation: ChatBubbleLeftRight,
    'envelope-open': EnvelopeOpen,
    'mail-open': EnvelopeOpen,
    envelope: Envelope,
    mail: Envelope,

    // Notifications
    bell: Bell,
    notification: Bell,
    'bell-alert': BellAlert,
    'bell-slash': BellSlash,
    'notification-off': BellSlash,
    megaphone: Megaphone,
    announce: Megaphone,

    // Tags & Labels
    flag: Flag,
    tag: Tag,
    hashtag: Hashtag,
    'at-symbol': AtSymbol,
    at: AtSymbol,

    // Sizing
    expand: ArrowsPointingOut,
    'arrows-pointing-out': ArrowsPointingOut,
    fullscreen: ArrowsPointingOut,
    collapse: ArrowsPointingIn,
    'arrows-pointing-in': ArrowsPointingIn,
    'exit-fullscreen': ArrowsPointingIn,

    // 3D & Stacks
    'square-3-stack-3d': Square3Stack3d,
    layers: Square3Stack3d,
    cube: Cube,
    'cube-transparent': CubeTransparent,

    // Development
    beaker: Beaker,
    experiment: Beaker,
    'light-bulb': LightBulb,
    idea: LightBulb,
    bulb: LightBulb,
    rocket: RocketLaunch,
    'rocket-launch': RocketLaunch,
    launch: RocketLaunch,
    puzzle: PuzzlePiece,
    'puzzle-piece': PuzzlePiece,
    terminal: CommandLine,
    'command-line': CommandLine,
    code: CodeBracket,
    'code-bracket': CodeBracket,

    // Infrastructure
    database: CircleStack,
    'circle-stack': CircleStack,
    server: ServerStack,
    'server-stack': ServerStack,
    cpu: CpuChip,
    'cpu-chip': CpuChip,
    wrench: Wrench,
    'wrench-screwdriver': WrenchScrewdriver,
    tools: WrenchScrewdriver,

    // Buildings
    office: BuildingOffice,
    'building-office': BuildingOffice,
    library: BuildingLibrary,
    'building-library': BuildingLibrary,

    // Achievements
    'academic-cap': AcademicCap,
    graduation: AcademicCap,
    trophy: Trophy,
    award: Trophy,

    // Misc
    'no-symbol': NoSymbol,
    ban: NoSymbol,
    forbidden: NoSymbol,
    'minus-circle': MinusCircle,
    'plus-circle': PlusCircle,
    'arrow-path-rounded-square': ArrowPathRoundedSquare,
    sync: ArrowPathRoundedSquare,
    'arrow-uturn-left': ArrowUturnLeft,
    undo: ArrowUturnLeft,
    'arrow-uturn-right': ArrowUturnRight,
    redo: ArrowUturnRight,
    login: ArrowRightOnRectangle,
    'arrow-right-on-rectangle': ArrowRightOnRectangle,
    logout: ArrowLeftOnRectangle,
    'arrow-left-on-rectangle': ArrowLeftOnRectangle,
    'qr-code': QrCode,
    qr: QrCode,
};

/**
 * Get an icon component by name
 * @param name - The icon name (case-insensitive, supports kebab-case)
 * @returns The icon component or undefined if not found
 */
export function getIcon(name: string): IconSource | undefined {
    if (!name) return undefined;

    // Normalize the name: lowercase and trim
    const normalizedName = name.toLowerCase().trim();

    return iconRegistry[normalizedName];
}

/**
 * Get an icon component by name with a fallback
 * @param name - The icon name
 * @param fallback - Fallback icon name if primary not found
 * @returns The icon component
 */
export function getIconWithFallback(
    name: string,
    fallback: string = 'question-mark-circle',
): IconSource {
    return getIcon(name) || getIcon(fallback) || QuestionMarkCircle;
}

/**
 * Check if an icon name exists in the registry
 * @param name - The icon name to check
 * @returns boolean
 */
export function hasIcon(name: string): boolean {
    if (!name) return false;
    return name.toLowerCase().trim() in iconRegistry;
}

/**
 * Get all available icon names
 * @returns Array of icon names
 */
export function getAvailableIcons(): string[] {
    return Object.keys(iconRegistry);
}

export { iconRegistry };
export type { IconSource };
