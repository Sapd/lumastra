// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use std::time::{Duration, SystemTime};
use url::Url;

struct Cookie {
    origin: String,
    path: String,
    name: String,
    pair: String,
    secure: bool,
    expires: Option<SystemTime>,
}

/// Per-ingest cookies deliberately never broaden their original origin.
#[derive(Default)]
pub(crate) struct UpstreamCookies {
    entries: Vec<Cookie>,
}

impl UpstreamCookies {
    pub(crate) fn set(&mut self, url: &Url, value: &str, now: SystemTime) {
        if value.len() > 4096 {
            return;
        }
        let mut pieces = value.split(';');
        let Some(pair) = pieces.next() else { return };
        let Some((name, value)) = pair.split_once('=') else {
            return;
        };
        let name = name.trim();
        if name.is_empty() || name.bytes().any(|b| b <= 32 || b >= 127 || b == b';') {
            return;
        }
        let mut path = url
            .path()
            .rsplit_once('/')
            .map_or("/", |(p, _)| p)
            .to_owned();
        if path.is_empty() {
            path.push('/');
        }
        let mut secure = false;
        let mut expires = None;
        let mut max_age = None;
        for attribute in pieces {
            let (key, val) = attribute
                .trim()
                .split_once('=')
                .unwrap_or((attribute.trim(), ""));
            let val = val.trim();
            match key.to_ascii_lowercase().as_str() {
                "path" if val.starts_with('/') => path = val.to_owned(),
                "secure" => secure = true,
                "domain" => {
                    let domain = val.trim_start_matches('.').to_ascii_lowercase();
                    let host = url.host_str().unwrap_or("");
                    if host != domain && !host.ends_with(&format!(".{domain}")) {
                        return;
                    }
                }
                "expires" => expires = httpdate::parse_http_date(val).ok(),
                "max-age" => max_age = val.parse::<i64>().ok(),
                _ => {}
            }
        }
        if let Some(age) = max_age {
            expires = Some(if age <= 0 {
                now
            } else {
                now.checked_add(Duration::from_secs(age as u64))
                    .unwrap_or(now)
            });
        }
        let origin = url.origin().ascii_serialization();
        self.entries.retain(|cookie| {
            cookie.expires.is_none_or(|t| t > now)
                && !(cookie.origin == origin && cookie.path == path && cookie.name == name)
        });
        if expires.is_some_and(|t| t <= now) {
            return;
        }
        self.entries.push(Cookie {
            origin,
            path,
            name: name.to_owned(),
            pair: format!("{name}={value}"),
            secure,
            expires,
        });
        if self.entries.len() > 256 {
            self.entries.remove(0);
        }
    }

    pub(crate) fn get(&mut self, url: &Url, now: SystemTime) -> Option<String> {
        self.entries
            .retain(|cookie| cookie.expires.is_none_or(|t| t > now));
        let origin = url.origin().ascii_serialization();
        let mut matching: Vec<_> = self
            .entries
            .iter()
            .filter(|cookie| {
                cookie.origin == origin
                    && (!cookie.secure || url.scheme() == "https")
                    && (url.path() == cookie.path
                        || url
                            .path()
                            .starts_with(&format!("{}/", cookie.path.trim_end_matches('/'))))
            })
            .collect();
        matching.sort_by_key(|cookie| std::cmp::Reverse(cookie.path.len()));
        if matching.is_empty() {
            None
        } else {
            Some(
                matching
                    .iter()
                    .map(|cookie| cookie.pair.as_str())
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_path_secure_expiry_and_bounds() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1);
        let source = Url::parse("https://source.example/private/channel").unwrap();
        let mut jar = UpstreamCookies::default();
        jar.set(&source, "token=wide; Path=/", now);
        jar.set(
            &source,
            "token=narrow; Path=/private; Secure; Max-Age=2",
            now,
        );
        assert_eq!(
            jar.get(&source, now).as_deref(),
            Some("token=narrow; token=wide")
        );
        assert_eq!(
            jar.get(
                &Url::parse("https://source.example/private-other/a").unwrap(),
                now
            )
            .as_deref(),
            Some("token=wide")
        );
        assert_eq!(
            jar.get(&Url::parse("http://source.example/private/a").unwrap(), now),
            None
        );
        assert_eq!(
            jar.get(&Url::parse("https://other.example/private/a").unwrap(), now),
            None
        );
        assert_eq!(
            jar.get(&source, now + Duration::from_secs(2)).as_deref(),
            Some("token=wide")
        );
        jar.set(&source, "token=deleted; Path=/; Max-Age=0", now);
        assert_eq!(jar.get(&source, now + Duration::from_secs(2)), None);
        for index in 0..=256 {
            jar.set(
                &Url::parse(&format!("https://host{index}.example/")).unwrap(),
                "a=1",
                now,
            );
        }
        assert_eq!(jar.entries.len(), 256);
        assert_eq!(
            jar.get(&Url::parse("https://host0.example/").unwrap(), now),
            None
        );
        jar.set(&source, &format!("big={}", "x".repeat(4096)), now);
        assert_eq!(jar.entries.len(), 256);
    }
}
