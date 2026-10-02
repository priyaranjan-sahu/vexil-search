use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use quick_xml::escape::unescape;
use quick_xml::events::Event;
use quick_xml::Reader;

const MAX_EXTRACT_CHARS: usize = 65_536;
const MAX_TEXT_BYTES: u64 = 262_144;
const MAX_ZIP_ENTRY_BYTES: u64 = 1_048_576;

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
        "docx" | "pptx" | "xlsx" | "epub" => safe(|| zip_text(path, &ext)).unwrap_or_default(),
        "pdf" => {
            safe(|| pdf_extract::extract_text(path).map_err(|e| e.to_string())).unwrap_or_default()
        }
        _ => safe(|| plain_text(path)).unwrap_or_default(),
    };
    text.chars().take(MAX_EXTRACT_CHARS).collect()
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
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn read_entry(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<String, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| format!("no '{name}': {e}"))?;
    let mut buf = Vec::new();
    entry
        .by_ref()
        .take(MAX_ZIP_ENTRY_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read '{name}': {e}"))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn zip_text(path: &Path, ext: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open '{path:?}': {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
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
                if let Ok(xml) = read_entry(&mut archive, &name) {
                    out.push_str(&collect_text(&xml, &["t"], &["p"], &[]));
                    out.push('\n');
                }
            }
            Ok(out)
        }
        "xlsx" => {
            let mut out = String::new();
            for name in ["xl/sharedStrings.xml", "xl/inlineStrings.xml"] {
                if let Ok(xml) = read_entry(&mut archive, name) {
                    out.push_str(&collect_text(&xml, &["t"], &["si", "row"], &[]));
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
                if let Ok(xml) = read_entry(&mut archive, &name) {
                    out.push_str(&collect_text(
                        &xml,
                        &[],
                        &[
                            "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6",
                        ],
                        &["style", "script"],
                    ));
                    out.push('\n');
                }
            }
            Ok(out)
        }
        _ => Err(format!("unsupported zip text format: {ext}")),
    }
}

fn archive_names(
    archive: &mut zip::ZipArchive<std::fs::File>,
    pred: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut names = Vec::new();
    for i in 0..archive.len() {
        if let Ok(f) = archive.by_index(i) {
            if pred(f.name()) {
                names.push(f.name().to_string());
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
            Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) => {
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
}
