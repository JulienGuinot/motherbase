# Next.js 15.5, App Router

The site is pinned to the `next` version in `package.json` (15.5). Check an API
against that version's documentation, not a newer one, and heed deprecation
notices in the build output.

# Every import must be a declared dependency

A bare `import x from 'pkg'` requires `pkg` in this project's `package.json`.
Not in `node_modules`. **Declared.**

npm hoists transitive dependencies, so a package reachable only through another
dependency's tree (`shiki` through `rehype-pretty-code`, for instance) resolves
today and breaks the build under a different install layout or an upgrade.

Before adding an import, check it is declared. If it resolves but is not
declared, it is a bug waiting for a different machine.
