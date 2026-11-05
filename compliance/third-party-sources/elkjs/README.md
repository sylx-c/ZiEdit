# elkjs 0.9.3-ziedit-source.1 — exact corresponding source for ZiEdit's rebuilt engine

ZiEdit's ELK engine is now a locally rebuilt, explicitly identified modification. Its Java/Xtend/MELK inputs are the complete ELK `v0.9.1` source at commit `62d5909f96fad541bc101ad52dabaece6b7eab7e`, with the original official PR #955 patch applied. Its wrapper source is elkjs commit `a8304cf79fde75bc2ab1a89d28320f53f8637436`. The compiler is the fixed published MELK `0.9.1`, with locked dependencies and SHA-256 verification, replacing the original publisher's unidentified `0.10.0-SNAPSHOT`. This is a new source build; it is not presented as an exact reproduction of the old npm-generated worker.

The complete [corresponding source archive](elkjs-0.9.3-ziedit-source.1.source.tar.gz) is supplied without an additional charge under the applicable original licenses. The machine-readable [manifest.json](manifest.json) records its size, SHA-256, fixed input identities and output correspondence. [override-manifest.json](override-manifest.json) permits only the two specifically hashed runtime files to differ from the original Mermaid release and records the complete removal of its old embedded ELK declaration.

The archive includes:

- Complete fixed ELK sources and tests with the documented PR patch, and complete elkjs wrapper sources, original license and build files. The upstream `lib/` directory containing the old unknown generated engine is excluded.
- The exact generated Java inputs used by the successful build, so MELK/Xtend input correspondence does not depend only on a URL.
- Actual GWT runtime source inputs, original resources/copyright/license files, with compiled `.class` entries excluded; original source identities and SHA-256 are recorded. The entire resolved compiler/build graph is identified separately so pure compiler tooling is not mistaken for application code.
- Original and local patch files, npm package lock, Gradle dependency locks and SHA-256 verification metadata, Gradle wrapper and its original license/NOTICE, and a Windows-compatible JavaScript build script.
- Output hashes and successful build/test records. Source copyright headers and component-specific license material are preserved; third-party components are not relicensed as one blanket EPL-2.0.

## Build, inspect and modify

Extract the source archive, install a supported JDK (tested with Temurin 17.0.21+9), Node/npm and the included fixed Gradle 7.2 wrapper. The exact official toolchain archive hashes and download locations are inside the source package; build-tool binaries are not shipped in this directory.

From the extracted package:

```sh
cd elkjs
npm ci --ignore-scripts
./gradlew lib -PelkRepo=../elk --dependency-verification strict
cd ..
node build-scripts/build-js.mjs
cd elkjs
node node_modules/mocha/bin/mocha.js test/mocha --timeout 20000
```

On Windows use `gradlew.bat` in place of `./gradlew`. Build commands can obtain locked compiler dependencies from their declared registries; this archive is not an offline copy of every build tool. It contains the component's complete preferred modification sources, actual generated Java inputs and exact build material. Its portable JS script is usable from the extracted root. The full resolved build dependency/source provenance and any tool-only scope are recorded inside the package.

The original Gradle wrapper script and helper jar are retained with the original Gradle 7.2 Apache-2.0 license and distribution notice. The Temurin JDK is GPL-2.0 with Classpath Exception build tooling and its binaries are excluded from the application/source package. EPL-2.0 covers the fixed ELK and current wrapper/Xtext/Xtend sources; EMF GWT retains its original EPL-1.0 evidence and license; Google GWT/Guava/JsInterop/Elemental sources retain their Apache-2.0 notices; annotation code retains its own license. The archive preserves individual original notices and an official EPL-1.0 supplement. Inspect the per-file headers and library-specific COPYING/about/license material before further modification or redistribution.

## Verified correspondence and functionality

The build actually completed Java, MELK/Xtend and both pretty/minified GWT compilation, then Babel and Browserify. The rebuilt bundle SHA-256 is `5b7df2330222dccb754c01b5324de88bc9244cf925492851b4ded3581a02ebf0`. Its algorithm catalogue has the same 12 algorithms, including DisCo, and the same 224 options as the prior release. Thirteen representative graph layouts produce exactly equal JSON. All 43 upstream tests pass after documented test-only Windows worker harness adaptations: the same compiled worker source is supplied as a data URL, and the pretty worker's top-level declarations are isolated. No runtime layout code or test assertions were altered for that adaptation. Original failed test logs remain as development history, outside public distribution.

The coordinating integrator also reported five browser checks passing: actual `layout: elk` ordinary and nested/cyclic graphs, default flowchart, sequence and class diagrams all produce SVG, with network evidence that the new source engine module is actually requested. These browser results are integration evidence reported by the coordinating agent, not mislabelled as upstream tests.

The original unknown generated engine's complete 1,580,569-character Mermaid declaration is removed rather than bypassed. Every Mermaid renderer byte outside that declaration is preserved. The old npm archive and original repository archive containing its generated `lib/` are kept only as non-distributed development evidence. This public directory carries hashes and modification statements rather than redistributing those unknown generated bytes.

Run `node scripts/verify-corresponding-sources.mjs` from ZiEdit's root to verify the new archive, all covered Rust sources, runtime output hashes, source inventories and the narrowly scoped override. The application-wide notices and installed source-access integration are maintained by the coordinating task. Historic installers need a separate audit; bounded layout/browser regression success is not proof for every possible graph or a blanket legal guarantee.
