# New website asset provenance

These files document newly captured ZiEdit website images from this remediation session, not historical image authorship.

- `examples/zh/` and `examples/en/`: original fictional sample notes, task-list code and writing guides created for this capture. No external article, third-party sample or real customer/project data was copied. These new contributions use the repository MIT license in `LICENSE-ZiEdit.txt`.
- `raw/`: unmodified screenshot bytes. Published files in `website/shots/` and `website/og.png` are byte-for-byte copies.
- `native-capture.json`: executable SHA256, separately recorded current dist hashes, actual loaded native application asset hashes, sample hashes, real application state and screenshot hashes. The independent review build is identified honestly; it is not asserted to equal a newer dist snapshot.
- `og-capture.json`: real browser/site input hashes and raw website first-viewport capture. The website files are served on a temporary loopback static server; no visual DOM or stylesheet is injected.

Reproduce or validate with `node scripts/capture-website-assets.mjs --native`, `--og`, or `--verify`. Use an independently identified `ziedit-review.exe` and an idle debugging port. `--native` uses actual CLI file opening, application settings IPC and real controls; it does not alter the application's layout or theme definitions. `--verify` checks recorded samples, image bytes, raw/published identity, script hash and website inputs.

Depicted fonts, application icons and other components retain their respective notices. This capture record does not claim new ownership over those components, establish authorship of replaced historical images, or clear the entire application or website for release. Final binary/website changes require review and, where relevant, recapture. No commit, push or deployment is performed by this script.
