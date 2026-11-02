// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde::Serialize;
use std::collections::BTreeMap;

const MAX_BOX: usize = 100 * 1024 * 1024;
#[derive(Debug, Clone, Serialize)]
pub struct Mp4Box {
    #[serde(rename = "type")]
    pub kind: String,
    pub data: Vec<u8>,
}
#[derive(Debug, Serialize)]
pub struct MediaSegment {
    pub data: Vec<u8>,
    pub duration: f64,
}
#[derive(Default)]
pub struct Mp4Parser {
    buffer: Vec<u8>,
    init: Option<Vec<u8>>,
    init_boxes: Vec<Vec<u8>>,
    moof: Option<Vec<u8>>,
    timescales: BTreeMap<u32, u32>,
    offsets: BTreeMap<u32, u64>,
}

fn u32_at(data: &[u8], at: usize) -> Result<u32, String> {
    Ok(u32::from_be_bytes(
        data.get(at..at.checked_add(4).ok_or("invalid_mp4")?)
            .ok_or("invalid_mp4")?
            .try_into()
            .map_err(|_| "invalid_mp4")?,
    ))
}
fn u64_at(data: &[u8], at: usize) -> Result<u64, String> {
    Ok(u64::from_be_bytes(
        data.get(at..at.checked_add(8).ok_or("invalid_mp4")?)
            .ok_or("invalid_mp4")?
            .try_into()
            .map_err(|_| "invalid_mp4")?,
    ))
}
fn children(data: &[u8], start: usize, end: usize) -> Result<Vec<(usize, usize, [u8; 4])>, String> {
    if end > data.len() || start > end {
        return Err("invalid_mp4".into());
    }
    let mut result = Vec::new();
    let mut at = start;
    while at < end.saturating_sub(8) {
        let size = u32_at(data, at)? as usize;
        if size < 8 || size > end - at {
            break;
        }
        let kind = data[at + 4..at + 8].try_into().map_err(|_| "invalid_mp4")?;
        result.push((at, size, kind));
        at += size;
    }
    Ok(result)
}
fn rebuilt(kind: &[u8; 4], parts: Vec<Vec<u8>>) -> Result<Vec<u8>, String> {
    let length = parts
        .iter()
        .map(Vec::len)
        .sum::<usize>()
        .checked_add(8)
        .filter(|n| *n <= MAX_BOX)
        .ok_or("mp4_limit")?;
    let mut result = Vec::with_capacity(length);
    result.extend_from_slice(&(length as u32).to_be_bytes());
    result.extend_from_slice(kind);
    for part in parts {
        result.extend_from_slice(&part);
    }
    Ok(result)
}

impl Mp4Parser {
    pub fn init_segment(&self) -> Option<&[u8]> {
        self.init.as_deref()
    }
    pub fn reset(&mut self) {
        self.buffer.clear();
        self.init = None;
        self.init_boxes.clear();
        self.moof = None;
        self.offsets.clear();
        // TS reset retains track timescales; a new init overwrites track IDs.
    }
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Mp4Box>, String> {
        if self.buffer.len().saturating_add(chunk.len()) > MAX_BOX + 64 * 1024 {
            return Err("mp4_limit".into());
        }
        self.buffer.extend_from_slice(chunk);
        let mut boxes = Vec::new();
        let mut at = 0;
        while self.buffer.len() - at >= 8 {
            let size = u32_at(&self.buffer, at)? as usize;
            if !(8..=MAX_BOX).contains(&size) {
                at += 1;
                continue;
            }
            if self.buffer.len() - at < size {
                break;
            }
            let kind = match &self.buffer[at + 4..at + 8] {
                b"ftyp" => "ftyp",
                b"moov" => "moov",
                b"moof" => "moof",
                b"mdat" => "mdat",
                _ => "other",
            };
            boxes.push(Mp4Box {
                kind: kind.into(),
                data: self.buffer[at..at + size].to_vec(),
            });
            at += size;
        }
        if at != 0 {
            self.buffer.drain(..at);
        }
        Ok(boxes)
    }
    pub fn process(&mut self, boxes: Vec<Mp4Box>) -> Result<Vec<MediaSegment>, String> {
        let mut result = Vec::new();
        for item in boxes {
            match item.kind.as_str() {
                "ftyp" | "moov" => {
                    let length = self.init_boxes.iter().map(Vec::len).sum::<usize>();
                    if length.saturating_add(item.data.len()) > MAX_BOX {
                        return Err("mp4_limit".into());
                    }
                    if item.kind == "moov" {
                        self.parse_timescales(&item.data)?;
                        self.init_boxes.push(Self::strip_edts(&item.data)?);
                        self.init = Some(self.init_boxes.concat());
                    } else {
                        self.init_boxes.push(item.data);
                    }
                }
                "moof" => self.moof = Some(item.data),
                "mdat" => {
                    if let Some(mut moof) = self.moof.take() {
                        let duration = self.duration(&moof)?;
                        self.normalize(&mut moof)?;
                        moof.extend_from_slice(&item.data);
                        result.push(MediaSegment {
                            data: moof,
                            duration,
                        });
                    }
                }
                _ => {}
            }
        }
        Ok(result)
    }
    fn parse_timescales(&mut self, data: &[u8]) -> Result<(), String> {
        for (at, size, kind) in children(data, 8, u32_at(data, 0)? as usize)? {
            if &kind != b"trak" {
                continue;
            }
            let mut track = None;
            let mut scale = None;
            for (pos, length, name) in children(data, at + 8, at + size)? {
                if &name == b"tkhd" {
                    track = Some(u32_at(
                        data,
                        pos + if data.get(pos + 8) == Some(&1) {
                            28
                        } else {
                            20
                        },
                    )?);
                }
                if &name == b"mdia" {
                    for (mpos, _, mname) in children(data, pos + 8, pos + length)? {
                        if &mname == b"mdhd" {
                            scale = Some(u32_at(
                                data,
                                mpos + if data.get(mpos + 8) == Some(&1) {
                                    28
                                } else {
                                    20
                                },
                            )?);
                        }
                    }
                }
            }
            if let (Some(track), Some(scale)) = (track, scale) {
                if !self.timescales.contains_key(&track) && self.timescales.len() >= 1024 {
                    return Err("mp4_limit".into());
                }
                self.timescales.insert(track, scale);
            }
        }
        Ok(())
    }
    fn duration(&self, data: &[u8]) -> Result<f64, String> {
        let mut best = 0f64;
        for (at, size, kind) in children(data, 8, u32_at(data, 0)? as usize)? {
            if &kind != b"traf" {
                continue;
            }
            let mut track = None;
            let mut default = None;
            let mut count = 0;
            let mut total = 0f64;
            let mut per_sample = false;
            for (pos, _, name) in children(data, at + 8, at + size)? {
                if &name == b"tfhd" {
                    let flags = u32_at(data, pos + 8)? & 0xffffff;
                    track = Some(u32_at(data, pos + 12)?);
                    let offset = pos
                        + 16
                        + if flags & 1 != 0 { 8 } else { 0 }
                        + if flags & 2 != 0 { 4 } else { 0 };
                    if flags & 8 != 0 {
                        default = Some(u32_at(data, offset)?);
                    }
                } else if &name == b"trun" {
                    let flags = u32_at(data, pos + 8)? & 0xffffff;
                    count = u32_at(data, pos + 12)?;
                    if flags & 0x100 != 0 {
                        per_sample = true;
                        let mut offset = pos
                            + 16
                            + if flags & 1 != 0 { 4 } else { 0 }
                            + if flags & 4 != 0 { 4 } else { 0 };
                        // Each sample consumes at least four bytes; reject before looping
                        // an attacker-controlled count beyond the current bounded box.
                        if count as usize > data.len().saturating_sub(offset) / 4 {
                            return Err("invalid_mp4".into());
                        }
                        for _ in 0..count {
                            total += f64::from(u32_at(data, offset)?);
                            offset += 4;
                            for flag in [0x200, 0x400, 0x800] {
                                if flags & flag != 0 {
                                    offset += 4;
                                }
                            }
                        }
                    }
                }
            }
            let scale = f64::from(
                track
                    .and_then(|t| self.timescales.get(&t).copied())
                    .unwrap_or(90000),
            );
            let d = if per_sample && total > 0.0 {
                total / scale
            } else if let Some(default) = default.filter(|_| count > 0) {
                f64::from(default) * f64::from(count) / scale
            } else {
                0.0
            };
            if d > best {
                best = d;
            }
        }
        Ok(if best > 0.0 { best } else { 6.0 })
    }
    fn strip_edts(data: &[u8]) -> Result<Vec<u8>, String> {
        let entries = children(data, 8, u32_at(data, 0)? as usize)?;
        let mut has_edts = false;
        for (at, size, kind) in &entries {
            if kind == b"trak"
                && children(data, at + 8, at + size)?
                    .iter()
                    .any(|(_, _, name)| name == b"edts")
            {
                has_edts = true;
                break;
            }
        }
        if !has_edts {
            return Ok(data.to_vec());
        }
        let mut parts = Vec::new();
        for (at, size, kind) in entries {
            if &kind == b"trak" {
                let track_parts = children(data, at + 8, at + size)?
                    .into_iter()
                    .filter(|(_, _, name)| name != b"edts")
                    .map(|(p, n, _)| data[p..p + n].to_vec())
                    .collect();
                parts.push(rebuilt(b"trak", track_parts)?);
            } else {
                parts.push(data[at..at + size].to_vec());
            }
        }
        rebuilt(b"moov", parts)
    }
    fn normalize(&mut self, data: &mut [u8]) -> Result<(), String> {
        for (at, size, kind) in children(data, 8, u32_at(data, 0)? as usize)? {
            if &kind != b"traf" {
                continue;
            }
            let mut track = None;
            let mut tfdt = None;
            for (pos, _, name) in children(data, at + 8, at + size)? {
                if &name == b"tfhd" {
                    track = Some(u32_at(data, pos + 12)?);
                }
                if &name == b"tfdt" {
                    tfdt = Some(pos);
                }
            }
            if let (Some(track), Some(pos)) = (track, tfdt) {
                let v1 = data.get(pos + 8) == Some(&1);
                let value = if v1 {
                    u64_at(data, pos + 12)?
                } else {
                    u64::from(u32_at(data, pos + 12)?)
                };
                if !self.offsets.contains_key(&track) && self.offsets.len() >= 1024 {
                    return Err("mp4_limit".into());
                }
                let offset = self.offsets.entry(track).or_insert(value);
                let normalized = value.checked_sub(*offset).ok_or("invalid_mp4_timestamp")?;
                if v1 {
                    data.get_mut(pos + 12..pos + 20)
                        .ok_or("invalid_mp4")?
                        .copy_from_slice(&normalized.to_be_bytes());
                } else {
                    data.get_mut(pos + 12..pos + 16)
                        .ok_or("invalid_mp4")?
                        .copy_from_slice(
                            &u32::try_from(normalized)
                                .map_err(|_| "invalid_mp4_timestamp")?
                                .to_be_bytes(),
                        );
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_structural_boxes_return_errors_instead_of_panicking() {
        let mut parser = Mp4Parser::default();
        let malformed = Mp4Box {
            kind: "moov".into(),
            data: vec![0, 0, 0, 32, b'm', b'o', b'o', b'v'],
        };
        assert!(parser.process(vec![malformed]).is_err());
    }
    #[test]
    fn chunked_box_and_corruption_recovery_is_incremental() {
        let mut parser = Mp4Parser::default();
        assert!(parser.push(&[0xff, 0, 0, 0, 12, b'f']).unwrap().is_empty());
        let boxes = parser.push(&[b't', b'y', b'p', 1, 2, 3, 4]).unwrap();
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].kind, "ftyp");
        assert_eq!(boxes[0].data.len(), 12);
        parser.process(boxes).unwrap();
        parser.reset();
        assert!(parser.init_segment().is_none());
    }
}
