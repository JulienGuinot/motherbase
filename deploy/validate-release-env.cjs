// Run before SSH: an incomplete production configuration must never deploy.
//
// Two groups, because they fail differently. Without the deploy credentials
// there is nothing to do at all, so they are always required. The smoke-test
// configuration describes a live project to exercise AFTER the deploy, and an
// installation that has not set one up yet should still be able to ship: those
// values are required only once any of them is set, because a half-configured
// smoke run is worse than none (it passes by skipping the checks it cannot
// make).
const DEPLOY_REQUIRED = [
  'VPS_HOST', 'VPS_SSH_KEY', 'VPS_KNOWN_HOSTS', 'VPS_USER', 'VPS_SSH_PORT',
  'VPS_REMOTE_DIR', 'GITHUB_SHA', 'GITHUB_REF_NAME',
];

const SMOKE_REQUIRED = [
  'CONSOLE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'PROJECT', 'PROJECT_URL',
  'PROJECT_EMAIL', 'PROJECT_PASSWORD', 'RLS_MODEL', 'PRIVATE_EDGE_ROUTE',
];

const REQUIRED = [...DEPLOY_REQUIRED, ...SMOKE_REQUIRED];

const isSet = env => key => Boolean(env[key]?.trim());

/** Whether the operator has asked for the post-deploy smoke run at all. */
function isSmokeConfigured(env) {
  return SMOKE_REQUIRED.some(isSet(env));
}

function validateReleaseEnv(env) {
  const set = isSet(env);
  const missing = [...DEPLOY_REQUIRED, ...(isSmokeConfigured(env) ? SMOKE_REQUIRED : [])];
  const errors = missing.filter(key => !set(key)).map(key => `${key} is required`);
  const check = (key, valid, message) => {
    if (env[key]?.trim() && !valid(env[key])) errors.push(`${key} ${message}`);
  };
  check('VPS_USER', value => /^[a-z_][a-z0-9_-]*$/.test(value) && value !== 'root', 'must be a non-root account');
  check('VPS_HOST', value => /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value), 'must be a hostname or IPv4 address');
  check('VPS_SSH_PORT', value => /^\d+$/.test(value) && +value > 0 && +value <= 65535, 'must be a valid port');
  check('VPS_REMOTE_DIR', value => /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith('-') && !value.split('/').includes('..'), 'must be a plain path without traversal');
  check('GITHUB_SHA', value => /^[a-f0-9]{40}$/.test(value), 'must be a full commit SHA');
  check('GITHUB_REF_NAME', value => /^v\d+\.\d+\.\d+$/.test(value), 'must be a release tag (vX.Y.Z)');
  check('PROJECT', value => /^[a-z0-9][a-z0-9-]*$/.test(value), 'must be a project slug');
  check('RLS_MODEL', value => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value), 'must be a table name');
  check('PRIVATE_EDGE_ROUTE', value => /^[a-zA-Z0-9_-]+$/.test(value), 'must be a single Edge route slug');
  for (const key of ['CONSOLE_URL', 'PROJECT_URL']) {
    check(key, value => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password &&
          url.pathname === '/' && !url.search && !url.hash;
      } catch { return false; }
    }, 'must be an HTTPS origin without credentials, query or path');
  }
  return errors;
}

module.exports = { validateReleaseEnv, isSmokeConfigured, DEPLOY_REQUIRED, SMOKE_REQUIRED, REQUIRED };
if (require.main === module) {
  const errors = validateReleaseEnv(process.env);
  if (errors.length) {
    // Only variable names and constraints, never credential values.
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    const smoke = isSmokeConfigured(process.env);
    if (!smoke) {
      // Loud, because a green deploy now means "shipped", not "shipped and
      // verified". Set the nine SMOKE_REQUIRED values to get the checks back.
      console.error(
        'WARNING: no post-deploy smoke configuration; the deploy will NOT be verified.\n' +
        `Set these to enable it: ${SMOKE_REQUIRED.join(', ')}`
      );
    }
    // Consumed by the workflow to decide whether to run the smoke steps.
    if (process.env.GITHUB_OUTPUT) {
      require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, `smoke=${smoke}\n`);
    }
  }
}
