import { REPO_URL } from '@/lib/site'

// The installer lives in the backend repository, next to the bundle it
// downloads and verifies, so it is versioned with the release it installs.
const INSTALLER_URL = `${REPO_URL.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/master/install.sh`

export function GET() {
  return Response.redirect(INSTALLER_URL, 307)
}
