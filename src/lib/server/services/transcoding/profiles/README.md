# Device profiles

These JSON files tell the transcode decision engine (`../device-profiles.ts`) what each client
can play directly. They use Jellyfin's `DeviceProfile` format and are bundled into the build.

## Origin and license

Five of the six profiles are adapted from the device-profile test data of the Jellyfin server,
<https://github.com/jellyfin/jellyfin>, folder `tests/Jellyfin.Model.Tests/Test Data/`:

| File              | Jellyfin source file                    | Changes                       |
| ----------------- | --------------------------------------- | ----------------------------- |
| `android-tv.json` | `DeviceProfile-AndroidTVExoPlayer.json` | values adjusted               |
| `chrome.json`     | `DeviceProfile-Chrome.json`             | values adjusted               |
| `roku.json`       | `DeviceProfile-RokuSSPlusNext.json`     | values adjusted               |
| `tizen.json`      | `DeviceProfile-Tizen4-4K-5.1.json`      | transcoding profiles adjusted |
| `webos.json`      | `DeviceProfile-WebOS-23.json`           | transcoding profiles adjusted |

Copyright (C) Jellyfin Contributors. Jellyfin is licensed under the GNU General Public License,
version 2 ([`LICENSES/GPL-2.0-only.txt`](../../../../../../LICENSES/GPL-2.0-only.txt)), and
publishes its `MediaBrowser.Model` package, which defines this format, under GPL-3.0. Lumastra
uses these files under GPL-3.0 ([`LICENSES/GPL-3.0-only.txt`](../../../../../../LICENSES/GPL-3.0-only.txt)),
which section 13 of both GPL-3.0 and AGPL-3.0 allows to be combined with Lumastra's AGPL-3.0 code.

`apple-tv.json` was written for Lumastra and is licensed AGPL-3.0-only like the rest of the code.

See also [`THIRD-PARTY-NOTICES.md`](../../../../../../THIRD-PARTY-NOTICES.md).
