# v5.6.3

Rebuilt on top of the complete working v5.6 frontend supplied by the user.

## Fixes
- Restores the full `static` project and package metadata.
- Retains staged JSM diagnostics from v5.6.1.
- Retains full Atlassian validation-response display.
- Uses the known-working React 18 / TypeScript configuration.
- Updates visible version to Forge v5.6.3.

## Validation
The TypeScript frontend check passed in the build environment.
Full Vite bundling must be run locally on Windows after `npm --prefix static install`
because the uploaded Windows `node_modules` contains Windows-specific Rollup binaries.
