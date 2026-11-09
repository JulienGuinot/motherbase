import site from './site.json'

// The literals live in site.json because next-sitemap.config.js is CJS and
// cannot import this module. A shared JSON file is the one format both sides
// read natively, so there is no second copy left to drift.
//
// The previous version only *claimed* this: its comment said "same source and
// fallback as next-sitemap.config.js" while both files held their own string
// literal, free to diverge at any time.

/** Canonical origin. SITE_URL overrides it in CI; the fallback is shared. */
export const SITE_URL = (process.env.SITE_URL || site.url).replace(/\/$/, '')

export const REPO_URL = site.repo
export const REPO_NAME = site.repoName
export const INSTALL_COMMAND = 'curl -fsSL https://www.motherbase.site/install.sh | bash'
export const CLIENT_PACKAGE = site.clientPackage
export const CLI_PACKAGE = site.cliPackage
