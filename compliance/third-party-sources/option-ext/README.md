# option-ext 0.2.0 — MPL-2.0 Source Code Form

This directory distributes the original, complete crates.io source archive for the exact `option-ext` version selected by ZiEdit's Cargo lockfile. It is provided without an additional charge under MPL-2.0. The archive contains the copyright/license notices, `LICENSE.txt`, the two Rust source files, the normalized and original Cargo manifests, README, and upstream VCS identity. ZiEdit's local files in this directory are provenance and instructions; they do not replace the upstream license.

- Original archive: [option-ext-0.2.0.crate](option-ext-0.2.0.crate)
- SHA-256: `04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d`
- Official source: <https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate>
- Registry evidence: [registry-metadata.json](registry-metadata.json), obtained from <https://crates.io/api/v1/crates/option-ext/0.2.0>
- Repository: <https://github.com/soc/option-ext>; upstream archive VCS commit `272f22fc9ea1ac6b08f01704af52c4ac338df4e2`.
- Machine-readable integrity and correspondence evidence: [manifest.json](manifest.json).

## Extract, inspect, modify and build

A `.crate` is a gzip-compressed tar archive. With Rust/Cargo and a tar implementation installed:

```sh
tar -xzf option-ext-0.2.0.crate
cd option-ext-0.2.0
cargo test
cargo build --release
```

This crate has no Cargo dependencies, build script, features, or generated source. `src/lib.rs` and `src/impl.rs` are its Source Code Form. For the application build use ZiEdit's Cargo lockfile and normal Tauri build instructions; the crate command above builds the component, not the desktop executable.

## Correspondence and obligations

The archive SHA-256 agrees with both official crates.io version metadata and the exact `option-ext` entry in ZiEdit's Cargo lockfile. During collection, every archive file was compared byte-for-byte with the Cargo registry source directory used by the local build; no local changes were found. The verifier repeats that comparison when the matching registry source is installed, and records absence rather than inventing evidence about an unavailable build cache. No claim is made about historic installers or an independently modified local Cargo cache.

MPL-2.0 Sections 3.1 and 3.2 require the covered Source Code Form to remain available under MPL-2.0 and recipients of executable form to be informed how to obtain it. Preserve the upstream notices and license; covered-file modifications must also be supplied under MPL-2.0. This local archive and accompanying source notice satisfy the source-availability part for the verified unmodified component when included and made accessible in the delivered application. The main application notice and packaging integration are maintained by the coordinating task, outside this directory.

Run `node scripts/verify-corresponding-sources.mjs` from the repository root to verify local source artifacts, lockfile correspondence and the ELK release gate. A passing archive hash alone is not a finding that all distribution obligations for the application are complete.
