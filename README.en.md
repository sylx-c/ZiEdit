# ZiEdit

[中文](README.md) | **[English](README.en.md)**

A cross-platform, offline-first desktop file viewer and editor supporting text, code, Markdown, CSV, images, and common document formats. Windows / macOS / Linux, built with Tauri 2 + Rust + CodeMirror 6.

Everything runs locally — no account required, no data uploaded. The only optional network feature is an S3-compatible image host that you configure yourself.

## Features

**Multi-format file viewing**
- Text and code viewing and editing; images (png / jpg / gif / webp / bmp / svg); CSV / TSV tables (switchable delimiters)
- Read-only docx / xlsx extraction and PDF text extraction (bounded and offline — not a layout engine)
- Automatic encoding detection (BOM → in-file declaration → heuristic → manual override) supporting GBK / GB18030 / UTF-8/16/32 / Shift_JIS and more; convert-encoding save and Unicode-normalization save
- Large files handled with ease: virtual scrolling + chunked reading keeps log-scale files smooth; tail panel with polling refresh

**Markdown**
- Four modes: source / preview / split / WYSIWYG, with incremental Live Preview rendering
- MathJax formulas, Mermaid diagrams, worker-based code highlighting, GFM table editing, outline navigation, formatting
- Optional S3 image upload (deduplication, rename templates; credentials kept in session memory only)

**File comparison**
- Two-file comparison: side-by-side / unified / A-B views
- Automatic diff classification: lookalike characters, Unicode normalization, invisible characters, whitespace, content

**Editing & Workbench**
- Rectangular/column selections and column editing, paste matrix, bookmarks, find & replace (single and multi-file), go-to-line
- File tree (multi-select, favorites, recent files, filter), command palette, system file icons
- Themes, font import, UI zooming, bilingual interface (zh-CN / en-US)
- Autosave and crash-recovery snapshots; system file associations: images, text/config files, Markdown, JSON/YAML/XML, CSV, and 24 source-code extensions

## Building from Source

The current version has only been tested on Windows. macOS and Linux installers are produced by CI and have not been verified on real machines — feedback via [Issues](https://github.com/sylx-c/ZiEdit/issues) is welcome. Prebuilt installers are available on the [Releases](https://github.com/sylx-c/ZiEdit/releases) page.

Requirements:

- Node.js ≥ 20, npm
- Rust stable (via rustup)
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
- macOS: Xcode Command Line Tools; Windows: WebView2 (preinstalled or auto-installed)

```bash
git clone https://github.com/sylx-c/ZiEdit.git
cd ZiEdit
npm ci
npm run tauri dev      # development
npm run tauri build    # installers (Windows NSIS / macOS dmg.app / Linux appimage deb rpm)
```

To debug the frontend only (without the desktop shell): `npm run dev`.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for common commands, test organization, and pre-commit checks; CI is defined in `.github/workflows/ci.yml`.

- Frontend tests: `npm test` (vitest, 1028 cases, organized by acceptance ID ac-0XX)
- Rust tests: `cargo test --manifest-path src-tauri/Cargo.toml` (140 unit tests)

## Contributing

Feedback and suggestions via issues are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a PR. For security issues see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Licenses of third-party components distributed with the app (MathJax, Mermaid, highlight.js, JetBrains Mono, etc.) are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
