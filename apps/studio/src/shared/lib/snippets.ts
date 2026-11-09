export type Framework = 'react' | 'next' | 'vue' | 'nuxt' | 'sveltekit' | 'expo' | 'js' | 'direct';

export interface ConnectInfo {
  apiUrl: string;
  wsUrl: string;
  sdkPackage: string;
  projectId?: string;
  anonKey?: string;
}

export interface Step {
  title: string;
  /** CodeMirror language hint. */
  lang: 'bash' | 'ts' | 'tsx' | 'env' | 'html' | 'vue';
  code: string;
  note?: string;
  /** Optional filename shown above the block. */
  file?: string;
}

const FRAMEWORK_LABELS: Record<Framework, string> = {
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  expo: 'Expo',
  js: 'JavaScript',
  direct: 'REST (direct)',
};

/** Ordered so the switcher reads like Supabase's Connect dialog. */
export const FRAMEWORKS: Framework[] = ['react', 'next', 'vue', 'nuxt', 'sveltekit', 'expo', 'js', 'direct'];

export function frameworkLabel(f: Framework): string {
  return FRAMEWORK_LABELS[f];
}

/** Build the ordered setup steps for a framework, pre-filled with real values. */
export function buildSteps(framework: Framework, info: ConnectInfo): Step[] {
  switch (framework) {
    case 'react': return spaSteps(info, { envPrefix: 'VITE', clientFile: 'src/client.ts', usage: reactUsage(), usageFile: 'src/App.tsx', usageLang: 'tsx' });
    case 'next': return nextSteps(info);
    case 'vue': return spaSteps(info, { envPrefix: 'VITE', clientFile: 'src/client.ts', usage: vueUsage(), usageFile: 'src/App.vue', usageLang: 'vue' });
    case 'nuxt': return nuxtSteps(info);
    case 'sveltekit': return svelteKitSteps(info);
    case 'expo': return expoSteps(info);
    case 'js': return jsSteps(info);
    case 'direct': return directSteps(info);
  }
}

// ── Shared building blocks ────────────────────────────────────────────────────

function installStep(info: ConnectInfo, extra = ''): Step {
  return {
    title: 'Install the SDK',
    lang: 'bash',
    code: `npm install ${info.sdkPackage}${extra}`,
    note: 'Add socket.io-client too if you plan to use realtime.',
  };
}

/**
 * The two values every client needs. Named like the create-motherbase-app
 * templates and the docs (`<PREFIX>MOTHERBASE_URL` / `<PREFIX>MOTHERBASE_KEY`),
 * so a value copied from here lands where the generated code reads it. This
 * step used to write the URL only, while the code below it read a key variable
 * that nothing had set.
 */
function envStep(info: ConnectInfo, prefix: string, file: string): Step {
  return {
    title: 'Add your backend URL and publishable key',
    lang: 'env',
    file,
    code: `${prefix}MOTHERBASE_URL=${info.apiUrl}\n${prefix}MOTHERBASE_KEY=${info.anonKey ?? 'mb_publishable_...'}`,
    note: info.projectId ? `Project ID: ${info.projectId}` : undefined,
  };
}

const USAGE_BODY = `      const { data: session } = await client.auth.signIn.email({ email: 'me@example.com', password: 'secret123' });
      const user = session?.user;
      const { data: products } = await client.from('products').select('*').limit(10);
      console.log(products);`;

// ── Single-page apps that share the Vite-style client (React, Vue) ────────────

interface SpaCfg {
  envPrefix: 'VITE';
  clientFile: string;
  usage: string;
  usageFile: string;
  usageLang: Step['lang'];
}

function spaSteps(info: ConnectInfo, cfg: SpaCfg): Step[] {
  return [
    installStep(info),
    envStep(info, `${cfg.envPrefix}_`, '.env'),
    {
      title: 'Create the client',
      lang: 'ts',
      file: cfg.clientFile,
      // localStorage, or the session is gone on every reload.
      code: `import { createClient, localStorageStorage } from '${info.sdkPackage}';

export const client = createClient(
  import.meta.env.${cfg.envPrefix}_MOTHERBASE_URL,
  import.meta.env.${cfg.envPrefix}_MOTHERBASE_KEY,
  { storage: localStorageStorage() },
);`,
    },
    {
      title: 'Sign in and read data',
      lang: cfg.usageLang,
      file: cfg.usageFile,
      code: cfg.usage,
    },
  ];
}

function reactUsage(): string {
  return `import { useEffect, useState } from 'react';
import { client } from './client';

export default function App() {
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    (async () => {
${USAGE_BODY}
      setEmail(user?.email);
    })();
  }, []);

  return <main>Signed in as {email ?? '…'}</main>;
}`;
}

function vueUsage(): string {
  return `<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { client } from './client';

const email = ref<string>();

onMounted(async () => {
${USAGE_BODY}
  email.value = user?.email;
});
</script>

<template>
  <main>Signed in as {{ email ?? '…' }}</main>
</template>`;
}

// ── Next.js ───────────────────────────────────────────────────────────────────

function nextSteps(info: ConnectInfo): Step[] {
  return [
    installStep(info),
    envStep(info, 'NEXT_PUBLIC_', '.env.local'),
    {
      title: 'Create the client',
      lang: 'ts',
      file: 'lib/client.ts',
      code: `import { createClient, cookieStorage } from '${info.sdkPackage}';

export const client = createClient(process.env.NEXT_PUBLIC_MOTHERBASE_URL!, process.env.NEXT_PUBLIC_MOTHERBASE_KEY, {
  storage: cookieStorage(),
});`,
      note: 'Rendering on the server too? @motherbase/ssr shares this session with Server Components.',
    },
    {
      title: 'Sign in and read data',
      lang: 'tsx',
      file: 'app/page.tsx',
      code: `'use client';
import { useEffect, useState } from 'react';
import { client } from '@/lib/client';

export default function Home() {
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    (async () => {
${USAGE_BODY}
      setEmail(user?.email);
    })();
  }, []);

  return <main>Signed in as {email ?? '…'}</main>;
}`,
    },
  ];
}

// ── Nuxt ───────────────────────────────────────────────────────────────────────

function nuxtSteps(info: ConnectInfo): Step[] {
  return [
    installStep(info),
    envStep(info, 'NUXT_PUBLIC_', '.env'),
    {
      title: 'Expose the client as a plugin',
      lang: 'ts',
      file: 'plugins/client.ts',
      code: `import { createClient, cookieStorage } from '${info.sdkPackage}';

export default defineNuxtPlugin(() => {
  const { public: cfg } = useRuntimeConfig();
  const client = createClient(cfg.motherbaseUrl as string, cfg.motherbaseKey as string | undefined, {
    storage: cookieStorage(),
  });
  return { provide: { client } };
});`,
      note: 'Declare `runtimeConfig.public.motherbaseUrl` and `motherbaseKey` in nuxt.config.ts; Nuxt fills them from NUXT_PUBLIC_MOTHERBASE_URL and NUXT_PUBLIC_MOTHERBASE_KEY.',
    },
    {
      title: 'Sign in and read data',
      lang: 'vue',
      file: 'app.vue',
      code: `<script setup lang="ts">
const { $client } = useNuxtApp();
const email = ref<string>();

onMounted(async () => {
  const { data: session } = await $client.auth.signIn.email({ email: 'me@example.com', password: 'secret123' });
  const user = session?.user;
  const { data: products } = await $client.from('products').select('*').limit(10);
  console.log(products);
  email.value = user?.email;
});
</script>

<template><main>Signed in as {{ email ?? '…' }}</main></template>`,
    },
  ];
}

// ── SvelteKit ──────────────────────────────────────────────────────────────────

function svelteKitSteps(info: ConnectInfo): Step[] {
  return [
    installStep(info),
    envStep(info, 'PUBLIC_', '.env'),
    {
      title: 'Create the client',
      lang: 'ts',
      file: 'src/lib/client.ts',
      code: `import { createClient, cookieStorage } from '${info.sdkPackage}';
import { PUBLIC_MOTHERBASE_URL, PUBLIC_MOTHERBASE_KEY } from '$env/static/public';

export const client = createClient(PUBLIC_MOTHERBASE_URL, PUBLIC_MOTHERBASE_KEY, {
  storage: cookieStorage(),
});`,
    },
    {
      title: 'Sign in and read data',
      lang: 'ts',
      file: 'src/routes/+page.svelte',
      code: `<script lang="ts">
  import { onMount } from 'svelte';
  import { client } from '$lib/client';

  let email: string | undefined;

  onMount(async () => {
    const { data: session } = await client.auth.signIn.email({ email: 'me@example.com', password: 'secret123' });
    const user = session?.user;
    const { data: products } = await client.from('products').select('*').limit(10);
    console.log(products);
    email = user?.email;
  });
</script>

<main>Signed in as {email ?? '…'}</main>`,
    },
  ];
}

// ── Expo / React Native ─────────────────────────────────────────────────────────

function expoSteps(info: ConnectInfo): Step[] {
  return [
    {
      title: 'Install the SDK',
      lang: 'bash',
      code: `npx expo install ${info.sdkPackage} @react-native-async-storage/async-storage`,
      note: 'AsyncStorage persists the session between app launches.',
    },
    envStep(info, 'EXPO_PUBLIC_', '.env'),
    {
      title: 'Create the client',
      lang: 'ts',
      file: 'lib/client.ts',
      code: `import { createClient, keyValueStorage } from '${info.sdkPackage}';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const client = createClient(process.env.EXPO_PUBLIC_MOTHERBASE_URL!, process.env.EXPO_PUBLIC_MOTHERBASE_KEY, {
  storage: keyValueStorage(AsyncStorage),
});`,
    },
    {
      title: 'Sign in and read the profile',
      lang: 'tsx',
      file: 'app/index.tsx',
      code: `import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { client } from '@/lib/client';

export default function Home() {
  const [email, setEmail] = useState<string>();

  useEffect(() => {
    (async () => {
${USAGE_BODY}
      setEmail(user?.email);
    })();
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Signed in as {email ?? '…'}</Text>
    </View>
  );
}`,
    },
  ];
}

// ── Vanilla JavaScript (bundler or ESM CDN) ──────────────────────────────────────

function jsSteps(info: ConnectInfo): Step[] {
  return [
    installStep(info),
    {
      title: 'Create the client and read data',
      lang: 'ts',
      file: 'main.js',
      code: `import { createClient } from '${info.sdkPackage}';

const client = createClient('${info.apiUrl}'${info.anonKey ? `, '${info.anonKey}'` : ''});

const { data: session } = await client.auth.signIn.email({ email: 'me@example.com', password: 'secret123' });
const user = session?.user;
const { data: products } = await client.from('products').select('*').limit(10);
console.log(user?.email, products);`,
    },
    {
      title: 'No bundler? Import straight from a CDN',
      lang: 'html',
      code: `<script type="module">
  import { createClient } from 'https://esm.sh/${info.sdkPackage}';
  const client = createClient('${info.apiUrl}');
  const { data } = await client.from('products').select('*').limit(10);
  console.log(data);
</script>`,
    },
  ];
}

// ── Direct REST (no SDK), Supabase-style ──────────────────────────────────────────

function directSteps(info: ConnectInfo): Step[] {
  return [
    {
      title: 'Sign in to get an access token',
      lang: 'bash',
      code: `curl -X POST '${info.apiUrl}/api/auth/sign-in/email' \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"me@example.com","password":"secret123"}'`,
      note: 'The response sets the session cookie and returns a bearer token.',
    },
    {
      title: 'Read rows over REST',
      lang: 'bash',
      code: `curl '${info.apiUrl}/rest/v1/products?select=*&limit=10' \\
  -H 'Authorization: Bearer <ACCESS_TOKEN>'`,
      note: 'PostgREST-style filters: ?column=eq.value, ?order=created_at.desc, ?limit=…',
    },
    {
      title: 'Insert a row',
      lang: 'bash',
      code: `curl -X POST '${info.apiUrl}/rest/v1/products' \\
  -H 'Authorization: Bearer <ACCESS_TOKEN>' \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"Widget","price":9.99}'`,
    },
    {
      title: 'Or from the browser with fetch',
      lang: 'ts',
      code: `const res = await fetch('${info.apiUrl}/rest/v1/products?select=*', {
  headers: { Authorization: \`Bearer \${accessToken}\` },
});
const products = await res.json();`,
    },
  ];
}
