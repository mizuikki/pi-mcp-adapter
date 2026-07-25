# Local Pi Fork Rules

- This private extension targets the sibling `../pi` fork and requires
  `ExtensionAPI.extensionSdkApiVersion === 1`.
- Every direct `@earendil-works/pi-*` import belongs in `peerDependencies` at
  `"*"` and in `devDependencies` as `file:../pi/packages/...`. Pi product
  versions do not define extension compatibility. Do not add Pi SDK packages
  to `dependencies` or import Pi source files.
- Fail closed on the extension SDK capability before registering anything.
- Install the extension through `pi install -l <absolute-source-path>`; do not
  add registry installation or publishing workflows.
- Fork fixtures use a `mkdtemp` system directory: `<temp>/pi` is the archived
  Pi checkout and `<temp>/project` is the extension copy. Read Pi's manifest,
  verify each SDK SHA-256 digest, and install all four SDK tarballs directly in
  positive consumers.
- Validate static Pi imports through the real Pi loader using poison packages.
  Do not infer provenance from a tarball filename or use `import.meta.resolve()`
  as a Jiti alias assertion.
- Blocking compatibility CI must use an immutable protected
  `pi-extension-sdk-v<major>.<minor>.<patch>` tag after the stacked migration;
  branch refs are only for the current coordination phase.
