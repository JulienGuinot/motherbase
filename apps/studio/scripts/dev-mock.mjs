// npm run studio:mock. Sets the mock flag and hands off to next dev; an inline
// VAR=value prefix in the npm script would not work on Windows.
import { spawn } from 'node:child_process';

spawn('next', ['dev', '-p', '5173'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXT_PUBLIC_MOCK: '1' },
}).on('exit', code => process.exit(code ?? 0));
