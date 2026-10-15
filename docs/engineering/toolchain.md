# Developer toolchain

The repository uses mise to activate the exact Node.js and Corepack versions in
`mise.toml`. Install mise 2026.10.4, trust this repository with `mise trust`,
then run `mise install` once. The project configuration selects Node.js 26.12.0
and Corepack 0.36.0.

Corepack selects Yarn 4.18.1 from the integrity-pinned `packageManager` field in
the root manifest. Use `yarn install --immutable` to install dependencies and
`yarn <script>` to run root scripts. Do not add a separate Yarn version pin or a
committed Yarn release file.

Yarn uses the `node-modules` linker because Plug'n'Play is incompatible with
parts of the ESLint, Vitest, and TypeScript tooling and the container deploy
step. Yarn scripts are disabled by default; the root manifest explicitly
allows the esbuild build script.
