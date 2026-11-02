// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde_json::{Value, json};

fn find_box(data: &[u8], name: &[u8; 4], from: usize) -> Option<usize> {
    let mut at = from;
    while at + 4 <= data.len() {
        let found = data[at..].windows(4).position(|b| b == name)? + at;
        if found < 4 {
            return None;
        }
        let size = u32::from_be_bytes(data[found - 4..found].try_into().ok()?) as usize;
        if size >= 8 && (found - 4).checked_add(size)? <= data.len() {
            return Some(found);
        }
        at = found + 1;
    }
    None
}
fn payload(data: &[u8], at: usize, extra: usize) -> Option<&[u8]> {
    let size = u32::from_be_bytes(data.get(at.checked_sub(4)?..at)?.try_into().ok()?) as usize;
    data.get((at + 4 + extra)..(at - 4 + size))
}
fn hevc(record: &[u8], entry: &str) -> Option<String> {
    if record.len() < 13 || record[0] != 1 {
        return None;
    }
    let space = ["", "A", "B", "C"][(record[1] >> 6) as usize];
    let compat = u32::from_be_bytes(record[2..6].try_into().ok()?).reverse_bits();
    let mut result = format!(
        "{entry}.{space}{}.{compat:X}.{}{}",
        record[1] & 31,
        if record[1] & 32 != 0 { "H" } else { "L" },
        record[12]
    );
    let constraints = &record[6..12];
    let length = constraints
        .iter()
        .rposition(|b| *b != 0)
        .map(|i| i + 1)
        .unwrap_or(0);
    for b in &constraints[..length] {
        result.push_str(&format!(".{b:X}"));
    }
    Some(result)
}
fn avc(record: &[u8], entry: &str) -> Option<String> {
    if record.len() < 4 || record[0] != 1 {
        return None;
    }
    Some(format!(
        "{entry}.{:02X}{:02X}{:02X}",
        record[1], record[2], record[3]
    ))
}
fn descriptor(data: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *data.get(at)?;
    let mut size = 0usize;
    let mut pos = at + 1;
    for _ in 0..4 {
        let Some(b) = data.get(pos) else { break };
        size = (size << 7) | usize::from(b & 127);
        pos += 1;
        if b & 128 == 0 {
            break;
        }
    }
    Some((tag, pos, size))
}
fn aac(data: &[u8]) -> Option<String> {
    let (tag, body, _) = descriptor(data, 0)?;
    if tag != 3 {
        return None;
    }
    let flags = *data.get(body + 2).unwrap_or(&0);
    let mut at = body + 3;
    if flags & 128 != 0 {
        at += 2;
    }
    if flags & 64 != 0 {
        at += 1 + usize::from(*data.get(at).unwrap_or(&0));
    }
    if flags & 32 != 0 {
        at += 2;
    }
    let (tag, body, _) = descriptor(data, at)?;
    if tag != 4 {
        return None;
    }
    let oti = *data.get(body)?;
    if oti != 64 {
        return Some(format!("mp4a.{oti:X}"));
    }
    let Some((5, body, _)) = descriptor(data, body + 13) else {
        return Some("mp4a.40.2".into());
    };
    let Some(b) = data.get(body) else {
        return Some("mp4a.40.2".into());
    };
    let mut object_type = b >> 3;
    if object_type == 31 && body + 1 < data.len() {
        object_type = 32 + (((b & 7) << 3) | (data[body + 1] >> 5));
    }
    Some(format!("mp4a.40.{object_type}"))
}

pub fn codecs_from_init(data: &[u8]) -> Value {
    let mut video = None;
    for (entry, config) in [
        ("hvc1", b"hvcC"),
        ("hev1", b"hvcC"),
        ("avc1", b"avcC"),
        ("avc3", b"avcC"),
    ] {
        let found = entry
            .as_bytes()
            .try_into()
            .ok()
            .and_then(|e| find_box(data, e, 0))
            .and_then(|at| find_box(data, config, at))
            .and_then(|at| payload(data, at, 0));
        video = found.and_then(|record| {
            if config == b"hvcC" {
                hevc(record, entry)
            } else {
                avc(record, entry)
            }
        });
        if video.is_some() {
            break;
        }
    }
    let audio = if let Some(at) = find_box(data, b"mp4a", 0) {
        match find_box(data, b"esds", at) {
            Some(esds) => payload(data, esds, 4).and_then(aac),
            None => Some("mp4a.40.2".into()),
        }
    } else if find_box(data, b"ac-3", 0).is_some() {
        Some("ac-3".into())
    } else if find_box(data, b"ec-3", 0).is_some() {
        Some("ec-3".into())
    } else {
        None
    };
    json!({"video": video, "audio": audio})
}

pub fn hevc_from_probe(profile: Option<&str>, level: Option<f64>) -> Option<String> {
    let level = level.filter(|v| *v > 0.0)?;
    match profile.map(str::to_lowercase).as_deref() {
        Some("main") => Some(format!("hvc1.1.6.L{level}.B0")),
        Some("main 10") => Some(format!("hvc1.2.4.L{level}.B0")),
        _ => None,
    }
}
pub fn video_range(transfer: Option<&str>) -> &'static str {
    match transfer.map(str::to_lowercase).as_deref() {
        Some("smpte2084" | "st2084") => "PQ",
        Some("arib-std-b67" | "hlg") => "HLG",
        _ => "SDR",
    }
}
