import { describe, expect, it } from 'vitest';
import { FRAMEWORKS, buildSteps, type ConnectInfo } from './snippets';

const info: ConnectInfo = {
  apiUrl: 'https://todo.example.com',
  wsUrl: 'wss://todo.example.com/ws',
  sdkPackage: '@motherbase/client',
  anonKey: 'mb_publishable_abc',
};

/** Every `<PREFIX>MOTHERBASE_*` name a step's code reads. */
const readsIn = (code: string) => new Set(code.match(/\b[A-Z_]*MOTHERBASE_(?:URL|KEY)\b/g) ?? []);

describe('Connect snippets', () => {
  // The env step used to write the URL only, while the client code read a key
  // variable nothing had set.
  it.each(FRAMEWORKS)('%s: the client reads only variables its .env step writes', framework => {
    const steps = buildSteps(framework, info);
    const env = steps.find(step => step.lang === 'env');
    const read = new Set(steps.filter(step => step.lang !== 'env').flatMap(step => [...readsIn(step.code)]));
    if (!env) {
      expect(read.size).toBe(0);
      return;
    }
    const written = new Set(env.code.split('\n').map(line => line.split('=')[0]));
    for (const name of read) expect(written, name).toContain(name);
  });

  it('pre-fills the publishable key when the project has one', () => {
    const env = buildSteps('next', info).find(step => step.lang === 'env')!;
    expect(env.code).toContain('NEXT_PUBLIC_MOTHERBASE_KEY=mb_publishable_abc');
    expect(env.code).toContain('NEXT_PUBLIC_MOTHERBASE_URL=https://todo.example.com');
  });

  it('keeps the session across reloads in a single-page app', () => {
    for (const framework of ['react', 'vue'] as const) {
      const code = buildSteps(framework, info).map(step => step.code).join('\n');
      expect(code, framework).toContain('localStorageStorage()');
    }
  });

  it('never tells people to call hydrate(): every request loads the session itself', () => {
    for (const framework of FRAMEWORKS) {
      const code = buildSteps(framework, info).map(step => step.code).join('\n');
      expect(code, framework).not.toContain('hydrate()');
    }
  });
});
