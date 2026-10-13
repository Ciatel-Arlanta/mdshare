// Embeds the app's reader page (app/reader/dist, built with
// `npm run build:reader` in app/) so the browser page renders markdown the
// same way the app does. Without it the server still builds and the browser
// page falls back to plain text.

use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../app/reader/dist");
    println!("cargo:rerun-if-changed={}", dist.display());

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for name in ["reader.js", "reader.css"] {
        let p = dist.join(name);
        if p.is_file() {
            files.push((name.to_string(), p));
        }
    }
    if let Ok(fonts) = fs::read_dir(dist.join("fonts")) {
        for entry in fonts.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".woff2") {
                files.push((format!("fonts/{name}"), entry.path()));
            }
        }
    }
    let complete =
        files.iter().any(|(n, _)| n == "reader.js") && files.iter().any(|(n, _)| n == "reader.css");
    if !complete {
        files.clear();
    }

    // Mermaid is large; ship it gzipped and serve it with Content-Encoding.
    let mermaid = dist.join("mermaid.min.js");
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    if complete && mermaid.is_file() {
        let gz = out_dir.join("mermaid.min.js.gz");
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        std::io::Write::write_all(&mut enc, &fs::read(&mermaid).unwrap()).unwrap();
        fs::write(&gz, enc.finish().unwrap()).unwrap();
        files.push(("mermaid.min.js.gz".into(), gz));
    }

    let mut code = String::from("pub static READER_ASSETS: &[(&str, &[u8])] = &[\n");
    for (name, path) in &files {
        let abs = fs::canonicalize(path).unwrap();
        code.push_str(&format!(
            "    ({name:?}, include_bytes!({:?})),\n",
            abs.display().to_string()
        ));
    }
    code.push_str("];\n");
    let out = out_dir.join("reader_assets.rs");
    fs::write(out, code).unwrap();
}
