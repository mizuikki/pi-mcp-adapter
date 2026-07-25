# Local Pi Fork Rules

- This private extension targets the sibling `../pi` fork and requires the
  `0.81.1-local.1` Pi SDK ABI.
- Every direct `@earendil-works/pi-*` import belongs in `peerDependencies` at
  that exact version and in `devDependencies` as `file:../pi/packages/...`.
  Do not add Pi SDK packages to `dependencies` or import Pi source files.
- Install the extension through `pi install -l <absolute-source-path>`; do not
  add registry installation or publishing workflows.
- Fork fixtures use a `mkdtemp` system directory: `<temp>/pi` is the archived
  Pi checkout and `<temp>/project` is the extension copy. Read Pi's manifest,
  verify each SDK SHA-256 digest, and install all four SDK tarballs directly in
  positive consumers.
- Validate static Pi imports through the real Pi loader using poison packages.
  Do not infer provenance from a tarball filename or use `import.meta.resolve()`
  as a Jiti alias assertion.
