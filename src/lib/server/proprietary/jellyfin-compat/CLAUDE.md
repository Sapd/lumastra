# jellyfin-compat/

The `/j` surface that lets Jellyfin client apps talk to Lumastra. Response shape matters more here than
anywhere else, because the apps decode strictly and fail silently.

## Traps

- **A missing non-nullable field makes the Kotlin apps silently never play.** jellyfin-sdk-kotlin
  generates a required constructor parameter for every OpenAPI property that is not `nullable` and has
  no `default`. One missing field in any nested object (a stream, a chapter, a subtitle entry) fails
  the decode of the whole response; the app swallows the error, playback never starts, and nothing is
  logged client-side. The decoder is strict: a number sent as a string throws, an unknown enum value
  falls back to a default only when the property has one, and a UUID must be hyphenated or 32
  lowercase hex characters.
- **Do not trust the TypeScript `@jellyfin/sdk` types as a check.** They mark everything optional.
  The contract suite (`npm run test:jellyfin-contract`) and `contract/build-digest.ts` derive "required"
  from the Kotlin SDK specs; regenerate the digest when a new SDK line ships, and run the suite after
  touching any `/j` response builder.
- **A new `/j` DTO must carry every field the matching SDK model requires**, including the ones you
  have no data for. Send a safe constant (`false`, an empty list) instead of omitting the field.
