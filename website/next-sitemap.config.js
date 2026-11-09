/** @type {import('next-sitemap').IConfig} */
module.exports = {
  // Same fallback literal as lib/site.ts, from the one file both can read.
  siteUrl: process.env.SITE_URL || require('./lib/site.json').url,
  generateRobotsTxt: true,
  robotsTxtOptions: {
    policies: [{ userAgent: '*', allow: '/' }],
  },
  outDir: 'public',
}
