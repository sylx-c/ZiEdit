# MPL-2.0 covered Rust components — complete exact source archives

This directory supplies, without an additional charge, the original Source Code Form of the following exact locked components under MPL-2.0. The complete source archives retain the upstream source files, copyright notices, original/normalized Cargo manifests, VCS identity, and any tests/build files included by their publishers. No upstream archive or source file was modified. Three archives contain full license texts; selectors' source headers identify MPL-2.0, and its omitted standalone license body is supplied separately below.

| Component | Complete original source | SHA-256 | Files checked against installed Cargo source |
|---|---|---|---:|
| cssparser 0.37.0 | [cssparser-0.37.0.crate](cssparser-0.37.0/cssparser-0.37.0.crate) | `8c9cdaae01d5ed7882b04d795e7f752f46ff52d2fa3b50a20d28c464510bba98` | 24 |
| cssparser-macros 0.7.1 | [cssparser-macros-0.7.1.crate](cssparser-macros-0.7.1/cssparser-macros-0.7.1.crate) | `d045de693cb712d0b22c6a64be5b953f67b3ce00ab5ad3dd5d8b441886ab8e1a` | 6 |
| dtoa-short 0.3.5 | [dtoa-short-0.3.5.crate](dtoa-short-0.3.5/dtoa-short-0.3.5.crate) | `cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87` | 6 |
| selectors 0.38.0 | [selectors-0.38.0.crate](selectors-0.38.0/selectors-0.38.0.crate) | `8adfa1c298912827b8a28b223b3b874357397ae706e6190acd9bf28cee99114d` | 22 |

The SHA-256 of every complete archive was checked against both the official crates.io exact-version metadata and ZiEdit's Cargo lockfile. Every archive file was compared byte-for-byte with the local Cargo registry source used by the current build cache. The machine-readable [manifest.json](manifest.json) records the official origins, source VCS commits, checksums and source inventories. Each package subdirectory also contains the original registry metadata and an inventory of every archived file with its hash. This evidence establishes the source artifacts and their correspondence to the locked unmodified components; it does not audit old installers.

Official archive sources:

- <https://static.crates.io/crates/cssparser/cssparser-0.37.0.crate>
- <https://static.crates.io/crates/cssparser-macros/cssparser-macros-0.7.1.crate>
- <https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate>
- <https://static.crates.io/crates/selectors/selectors-0.38.0.crate>

## Build and modification materials

A `.crate` is a gzip-compressed tar archive. With tar, Rust and Cargo installed, for example:

```sh
tar -xzf cssparser-0.37.0.crate
cd cssparser-0.37.0
cargo test
cargo build --release
```

Use the same commands after extracting any of the other archives, with its directory name. Cargo will resolve the dependencies declared in the original manifests; a publisher-included Cargo lockfile, if present, is retained. These instructions build/test the components and do not claim a fully offline build of their transitive dependency graph. The component source distribution includes all publisher-provided source and build files. For the actual desktop application, use ZiEdit's locked Cargo dependency graph and normal Tauri build instructions.

`cssparser`, `selectors` and `dtoa-short` are reached by the application's normal desktop dependency graph through Tauri utilities and DOM/CSS handling. `cssparser-macros` is a proc-macro host component; its precise source and generated-code implementation are supplied conservatively, rather than assuming its host role exempts it. This directory does not claim all these libraries are linked on every target or replace per-target dependency evidence.

## License and recipient access

The original source notices remain inside every archive, and full upstream MPL-2.0 texts remain where the publisher included them. The selectors archive does not include a standalone LICENSE; its source files explicitly carry MPL-2.0 notices. Its separate [MPL-2.0-supplement.txt](selectors-0.38.0/MPL-2.0-supplement.txt) is the unmodified full license body from [Mozilla's official fixed license text](https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt), SHA-256 `fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85`. This supplement is clearly identified as separately obtained and does not replace any upstream copyright notice or purport to be part of the original crate. Preserve all original notices. Under MPL-2.0 Sections 3.1 and 3.2, covered Source Code Form and covered-file modifications must remain available under MPL-2.0, and recipients of executable form must be told how to obtain it. These local exact archives support that obligation when included and made accessible with the delivered application's source notice. The coordinating task maintains the application-wide notice and installation access path.

The separately supplied `option-ext` 0.2.0 archive and its evidence are in [the option-ext directory](../option-ext/README.md). Run `node scripts/verify-corresponding-sources.mjs` from the repository root to verify all five MPL sources and the ELK source gate. `--allow-unresolved` verifies collected artifacts for development but never grants release approval for the unresolved ELK Java input.
