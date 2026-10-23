use std::io::{Cursor, Read, Seek};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;

const MAX_EXTRACT_CHARS: usize = 65_536;
const MAX_TEXT_BYTES: u64 = 262_144;
const MAX_ZIP_ENTRY_BYTES: u64 = 1_048_576;
/// Whole-file ceiling for formats we hand to a third-party extractor (PDF).
/// Those read the entire file into memory, so a single oversized input could
/// otherwise exhaust RAM before the final truncate ever runs.
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;

pub fn should_index_content(ext: &str) -> bool {
    matches!(
        ext.to_lowercase().as_str(),
        "txt"
            | "md"
            | "csv"
            | "json"
            | "rs"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "epub"
    )
}

pub fn extract_text(path: &Path, ext: &str) -> String {
    let ext = ext.to_lowercase();
    let text = match ext.as_str() {
        "docx" | "pptx" | "xlsx" | "epub" => safe(|| {
            let file = std::fs::File::open(path).map_err(|e| format!("open '{path:?}': {e}"))?;
            zip_text(file, &ext)
        })
        .unwrap_or_default(),
        "pdf" => {
            // Refuse to load an enormous file into the extractor; matching on
            // size here is cheap and bounds the extractor's memory up front.
            let too_big = std::fs::metadata(path)
                .map(|m| m.len() > MAX_SOURCE_BYTES)
                .unwrap_or(false);
            if too_big {
                String::new()
            } else {
                safe(|| pdf_extract::extract_text(path).map_err(|e| e.to_string()))
                    .unwrap_or_default()
            }
        }
        _ => safe(|| plain_text(path)).unwrap_or_default(),
    };
    text.chars().take(MAX_EXTRACT_CHARS).collect()
}

/// Same as [`extract_text`], but for content that never touches the filesystem.
///
/// Android's Storage Access Framework hands the indexer bytes from a picked
/// folder (`content://` documents), not a readable path, so the format
/// handlers run against an in-memory buffer instead.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn extract_text_from_bytes(bytes: &[u8], ext: &str) -> String {
    let ext = ext.to_lowercase();
    let text = match ext.as_str() {
        "docx" | "pptx" | "xlsx" | "epub" => {
            safe(|| zip_text(Cursor::new(bytes), &ext)).unwrap_or_default()
        }
        "pdf" => {
            if bytes.len() as u64 > MAX_SOURCE_BYTES {
                String::new()
            } else {
                safe(|| pdf_extract::extract_text_from_mem(bytes).map_err(|e| e.to_string()))
                    .unwrap_or_default()
            }
        }
        _ => decode_text(&bytes[..bytes.len().min(MAX_TEXT_BYTES as usize)]),
    };
    text.chars().take(MAX_EXTRACT_CHARS).collect()
}

/// Appends at most the remaining extraction budget, on a char boundary.
///
/// The final `truncate` in [`extract_text`] happens only after a format handler
/// has built its full string. For zip formats that means every entry's text is
/// held at once; bounding each append keeps the running total at
/// `MAX_EXTRACT_CHARS` instead of `entries × MAX_ZIP_ENTRY_BYTES`.
fn push_capped(dst: &mut String, src: &str) {
    if dst.len() >= MAX_EXTRACT_CHARS {
        return;
    }
    let remaining = MAX_EXTRACT_CHARS - dst.len();
    if src.len() <= remaining {
        dst.push_str(src);
        return;
    }
    let mut end = remaining;
    while end > 0 && !src.is_char_boundary(end) {
        end -= 1;
    }
    dst.push_str(&src[..end]);
}

fn safe(f: impl FnOnce() -> Result<String, String>) -> Option<String> {
    catch_unwind(AssertUnwindSafe(f))
        .ok()
        .and_then(|res| res.ok())
}

fn plain_text(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("open '{path:?}': {e}"))?;
    let mut buf = Vec::new();
    file.by_ref()
        .take(MAX_TEXT_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(decode_text(&buf))
}

/// Decodes bytes to text, honouring a UTF-16 byte-order mark.
///
/// Windows tools commonly write UTF-16LE `.txt`/`.csv` with a BOM; decoding
/// those as UTF-8 produces a string peppered with NULs that the trigram
/// tokenizer cannot match, so searches for their contents silently fail.
fn decode_text(bytes: &[u8]) -> String {
    if let [0xFF, 0xFE, rest @ ..] = bytes {
        let (chunks, _) = rest.as_chunks::<2>();
        let units: Vec<u16> = chunks.iter().map(|c| u16::from_le_bytes(*c)).collect();
        return String::from_utf16_lossy(&units);
    }
    if let [0xFE, 0xFF, rest @ ..] = bytes {
        let (chunks, _) = rest.as_chunks::<2>();
        let units: Vec<u16> = chunks.iter().map(|c| u16::from_be_bytes(*c)).collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn read_entry<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    name: &str,
) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("no '{name}': {e}"))?;
    let mut buf = Vec::new();
    entry
        .by_ref()
        .take(MAX_ZIP_ENTRY_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read '{name}': {e}"))?;
    Ok(decode_text(&buf))
}

fn zip_text<R: Read + Seek>(reader: R, ext: &str) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;
    match ext {
        "docx" => {
            let xml = read_entry(&mut archive, "word/document.xml")?;
            Ok(collect_text(&xml, &["t"], &["p", "tr", "tc"], &[]))
        }
        "pptx" => {
            let mut out = String::new();
            for name in archive_names(&mut archive, |n| {
                let lc = n.to_lowercase();
                lc.starts_with("ppt/slides/slide") && lc.ends_with(".xml")
            }) {
                if out.len() >= MAX_EXTRACT_CHARS {
                    break;
                }
                if let Ok(xml) = read_entry(&mut archive, &name) {
                    push_capped(&mut out, &collect_text(&xml, &["t"], &["p"], &[]));
                    out.push('\n');
                }
            }
            Ok(out)
        }
        "xlsx" => {
            let mut out = String::new();
            for name in ["xl/sharedStrings.xml", "xl/inlineStrings.xml"] {
                if out.len() >= MAX_EXTRACT_CHARS {
                    break;
                }
                if let Ok(xml) = read_entry(&mut archive, name) {
                    push_capped(&mut out, &collect_text(&xml, &["t"], &["si", "row"], &[]));
                    out.push('\n');
                }
            }
            // Catch strings written inline into a sheet (`t="inlineStr"`) rather
            // than into sharedStrings. They only ever appear as `<t>` elements,
            // so this adds real text without picking up the numeric cell
            // indices that a `<v>` sweep would.
            for name in archive_names(&mut archive, |n| {
                let lc = n.to_lowercase();
                lc.starts_with("xl/worksheets/sheet") && lc.ends_with(".xml")
            }) {
                if out.len() >= MAX_EXTRACT_CHARS {
                    break;
                }
                if let Ok(xml) = read_entry(&mut archive, &name) {
                    push_capped(&mut out, &collect_text(&xml, &["t"], &[], &[]));
                    out.push('\n');
                }
            }
            Ok(out)
        }
        "epub" => {
            let mut out = String::new();
            for name in archive_names(&mut archive, |n| {
                let lc = n.to_lowercase();
                lc.ends_with(".xhtml") || lc.ends_with(".html") || lc.ends_with(".htm")
            }) {
                if out.len() >= MAX_EXTRACT_CHARS {
                    break;
                }
                if let Ok(xml) = read_entry(&mut archive, &name) {
                    push_capped(
                        &mut out,
                        &collect_text(
                            &xml,
                            &[],
                            &[
                                "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5",
                                "h6",
                            ],
                            &["style", "script"],
                        ),
                    );
                    out.push('\n');
                }
            }
            Ok(out)
        }
        _ => Err(format!("unsupported zip text format: {ext}")),
    }
}

fn archive_names<R: Read + Seek>(
    archive: &mut zip::ZipArchive<R>,
    pred: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            // zip 9 makes `name()` fallible (it validates the stored encoding);
            // an unreadably encoded name is not text-filterable — skip it the
            // same way as an unreadable entry.
            if let Ok(n) = f.name() {
                if pred(&n) {
                    names.push(n.into_owned());
                }
            }
        }
    }
    names
}

fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, local)| local)
}

fn collect_text(xml: &str, scopes: &[&str], blocks: &[&str], skip: &[&str]) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut out = String::new();
    let mut scope_depth = 0usize;
    let mut skip_depth = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(ref e)) => {
                let qname = e.name();
                let name = local(qname.as_ref());
                if scopes.contains(&name) {
                    scope_depth += 1;
                }
                if skip.contains(&name) {
                    skip_depth += 1;
                }
                if skip_depth == 0
                    && (scopes.is_empty() || scope_depth > 0)
                    && blocks.contains(&name)
                {
                    out.push('\n');
                }
            }
            Ok(Event::Empty(ref e)) => {
                // A self-closing tag has no matching `End`, so it must not bump
                // the depth counters. Incrementing here (as the old combined arm
                // did) left `scope_depth`/`skip_depth` permanently inflated by
                // every `<.../>`, which silenced all subsequent text.
                let qname = e.name();
                let name = local(qname.as_ref());
                if skip_depth == 0
                    && (scopes.is_empty() || scope_depth > 0)
                    && blocks.contains(&name)
                {
                    out.push('\n');
                }
            }
            Ok(Event::End(ref e)) => {
                let qname = e.name();
                let name = local(qname.as_ref());
                if skip.contains(&name) {
                    skip_depth = skip_depth.saturating_sub(1);
                }
                if scopes.contains(&name) {
                    scope_depth = scope_depth.saturating_sub(1);
                }
            }
            Ok(Event::Text(ref t)) => {
                if skip_depth == 0 && (scopes.is_empty() || scope_depth > 0) {
                    if let Ok(s) = unescape(t) {
                        out.push_str(&s);
                    }
                }
            }
            Ok(Event::CData(ref t)) => {
                // Unescaped character data (e.g. RSS descriptions, embedded HTML)
                // was dropped by the catch-all arm; it is real searchable text.
                if skip_depth == 0 && (scopes.is_empty() || scope_depth > 0) {
                    out.push_str(t);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn write_file(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn minimal_pdf(text: &str) -> Vec<u8> {
        let stream = format!("BT /F1 12 Tf 72 720 Td ({}) Tj ET", text);
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}\nendstream", stream.len(), stream),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        let mut bytes = b"%PDF-1.4\n".to_vec();
        let mut offsets = Vec::new();
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(bytes.len());
            bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, obj).as_bytes());
        }
        let xref_pos = bytes.len();
        bytes.extend_from_slice(
            format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
        );
        for off in &offsets {
            bytes.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
        }
        bytes.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
                objects.len() + 1,
                xref_pos
            )
            .as_bytes(),
        );
        bytes
    }

    #[test]
    fn extracts_docx_text() {
        let dir = tempdir().unwrap();
        let xml = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Invoice for PROJECT_ALPHA planning</w:t></w:r></w:p></w:body></w:document>"#;
        let zip = make_zip(&[("word/document.xml", xml)]);
        let path = write_file(dir.path(), "invoice.docx", &zip);
        let text = extract_text(&path, "docx");
        assert!(text.contains("PROJECT_ALPHA"), "got: {text:?}");
        assert!(text.contains("planning"));
    }

    #[test]
    fn extracts_xlsx_shared_strings() {
        let dir = tempdir().unwrap();
        let sst = r#"<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>XLSX_KEYWORD_REVENUE</t></si></sst>"#;
        let zip = make_zip(&[("xl/sharedStrings.xml", sst)]);
        let path = write_file(dir.path(), "sheet.xlsx", &zip);
        let text = extract_text(&path, "xlsx");
        assert!(text.contains("XLSX_KEYWORD_REVENUE"), "got: {text:?}");
    }

    #[test]
    fn extracts_epub_body_but_not_styles() {
        let dir = tempdir().unwrap();
        let xhtml = r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><style>.a{color:red}</style></head><body><p>EPUB_BODY_MARKER novel</p></body></html>"#;
        let zip = make_zip(&[("content.xhtml", xhtml)]);
        let path = write_file(dir.path(), "book.epub", &zip);
        let text = extract_text(&path, "epub");
        assert!(text.contains("EPUB_BODY_MARKER"), "got: {text:?}");
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn extracts_plain_text() {
        let dir = tempdir().unwrap();
        let path = write_file(dir.path(), "notes.md", b"MARKDOWN_BODY hello world");
        let text = extract_text(&path, "md");
        assert_eq!(text, "MARKDOWN_BODY hello world");
    }

    #[test]
    fn decodes_utf16_with_bom() {
        let dir = tempdir().unwrap();
        // Windows tools write UTF-16LE with a BOM; decoded as UTF-8 it would be
        // full of NULs and the content would be unsearchable.
        let mut bytes = vec![0xFF, 0xFE];
        for u in "UTF16_MARKER notes".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let path = write_file(dir.path(), "utf16.txt", &bytes);
        let text = extract_text(&path, "txt");
        assert!(text.contains("UTF16_MARKER"), "got: {text:?}");
        assert!(!text.contains('\u{0}'));
    }

    #[test]
    fn extracts_xlsx_inline_strings() {
        let dir = tempdir().unwrap();
        let sheet = r#"<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>INLINE_CELL_MARKER</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>"#;
        let zip = make_zip(&[("xl/worksheets/sheet1.xml", sheet)]);
        let path = write_file(dir.path(), "inline.xlsx", &zip);
        let text = extract_text(&path, "xlsx");
        assert!(text.contains("INLINE_CELL_MARKER"), "got: {text:?}");
    }

    #[test]
    fn caps_total_extraction_across_zip_entries() {
        let dir = tempdir().unwrap();
        // Many large entries must not accumulate past the budget.
        let big = "y".repeat(60_000);
        let mut entries: Vec<(String, String)> = Vec::new();
        for i in 0..10 {
            entries.push((format!("ppt/slides/slide{i}.xml"), format!(
                r#"<p:sld xmlns:p="urn:p"><p:cSld><p:spTree><p:t>{big}</p:t></p:spTree></p:cSld></p:sld>"#
            )));
        }
        let refs: Vec<(&str, &str)> = entries
            .iter()
            .map(|(n, c)| (n.as_str(), c.as_str()))
            .collect();
        let zip = make_zip(&refs);
        let path = write_file(dir.path(), "deck.pptx", &zip);
        let text = extract_text(&path, "pptx");
        assert!(
            text.len() <= MAX_EXTRACT_CHARS,
            "total {} exceeded cap",
            text.len()
        );
    }

    #[test]
    fn caps_extracted_length() {
        let dir = tempdir().unwrap();
        let big = "x".repeat(200_000);
        let path = write_file(dir.path(), "big.txt", big.as_bytes());
        let text = extract_text(&path, "txt");
        assert!(text.len() <= MAX_EXTRACT_CHARS);
        assert_eq!(text.len(), MAX_EXTRACT_CHARS);
    }

    #[test]
    fn extracts_pdf_text() {
        let dir = tempdir().unwrap();
        let pdf = minimal_pdf("PDF_SEARCH_MARKER invoice");
        let path = write_file(dir.path(), "doc.pdf", &pdf);
        let text = extract_text(&path, "pdf");
        assert!(text.contains("PDF_SEARCH_MARKER"), "extracted: {text:?}");
    }

    #[test]
    fn gates_indexable_extensions() {
        assert!(should_index_content("DOCX"));
        assert!(should_index_content("pdf"));
        assert!(should_index_content("txt"));
        assert!(!should_index_content("png"));
        assert!(!should_index_content("exe"));
    }

    /// SAF hands the indexer bytes, not a path, so the handlers must run from a
    /// buffer too.
    #[test]
    fn extracts_structured_text_from_bytes() {
        let xml = r#"<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SAF_BYTES_MARKER</w:t></w:r></w:p></w:body></w:document>"#;
        let zip = make_zip(&[("word/document.xml", xml)]);
        let text = extract_text_from_bytes(&zip, "docx");
        assert!(text.contains("SAF_BYTES_MARKER"), "got: {text:?}");
    }

    #[test]
    fn decodes_utf16_bytes_without_a_path() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "SAF_UTF16_MARKER".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let text = extract_text_from_bytes(&bytes, "txt");
        assert!(text.contains("SAF_UTF16_MARKER"), "got: {text:?}");
        assert!(!text.contains('\u{0}'));
    }
}
