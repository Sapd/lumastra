# src/lib/

Core application library containing client components, server utilities, type schemas, and shared code.

## Files

| File                            | What                                            | When to read                                            |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `auth-monitor.ts`               | Authentication state monitor                    | Implementing auth state changes or session management   |
| `fetch-interceptor.ts`          | Global fetch interceptor                        | Debugging network requests or adding request middleware |
| `Footer.svelte`                 | Application footer component                    | Modifying footer layout or navigation                   |
| `ForYou.svelte`                 | For-You personalized content page               | Working on personalized recommendations UI              |
| `HolidayRecommendations.svelte` | Holiday-themed recommendations component        | Adding seasonal content features                        |
| `ModalMovie.svelte`             | Movie/series detail modal                       | Working on main content detail view                     |
| `MovieCalendar.svelte`          | Calendar view for upcoming episodes             | Implementing calendar features or episode scheduling    |
| `paths.ts`                      | Application route paths                         | Adding new routes or updating navigation links          |
| `pwa.ts`                        | Progressive web app service worker registration | Configuring PWA behavior or offline support             |
| `Search.svelte`                 | Universal search component                      | Working on search functionality or UI                   |
| `Sidebar.svelte`                | Application sidebar navigation                  | Modifying navigation menu or sidebar layout             |
| `Trending.svelte`               | Trending content component                      | Working on trending content display                     |
| `UpcomingEpisodes.svelte`       | Upcoming episodes widget                        | Implementing episode tracking features                  |
| `Watchlist.svelte`              | User watchlist component                        | Working on watchlist functionality                      |

## Subdirectories

| Directory     | What                                               | When to read                                                           |
| ------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `api/`        | Frontend API client with Zod validation            | Making API calls from client code or adding new endpoints              |
| `assets/`     | Static assets (images, icons)                      | Adding or referencing static resources                                 |
| `components/` | Reusable UI components by feature                  | Building UI or reusing existing components                             |
| `config/`     | Client-side configuration                          | Accessing client config or branding settings                           |
| `constants/`  | Application constants (genres, categories)         | Using genre lists, search categories, or fixed values                  |
| `icons/`      | SVG icon components                                | Adding or using icons                                                  |
| `paraglide/`  | i18n/localization messages                         | Working on translations or localized content                           |
| `schemas/`    | Zod schemas (single source of truth)               | Defining types, validating data, or generating OpenAPI specs           |
| `server/`     | Server-side code (database, services, AI)          | Implementing backend logic, database queries, or external integrations |
| `services/`   | Client-side services (data loading, notifications) | Loading data on client or managing client-side state                   |
| `shared/`     | Code shared between client and server              | Using utilities that work in both environments                         |
| `stores/`     | Svelte stores (state management)                   | Managing global client state or reactive data                          |
| `styles/`     | Global CSS and Tailwind styles                     | Styling components or customizing theme                                |
| `types/`      | TypeScript type re-exports from schemas            | Importing types (always prefer schemas/ as source)                     |
| `utils/`      | Client-side utility functions                      | Using data extraction, validation, formatting, or helper functions     |
