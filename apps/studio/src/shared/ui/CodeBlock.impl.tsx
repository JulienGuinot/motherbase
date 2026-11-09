import ShikiHighlighter, { type Language } from 'react-shiki';
import { useShikiTheme } from '@/shared/lib/theme';
import type { CodeBlockSize } from '@/shared/ui/CodeBlock';

const LANGUAGE_ALIAS: Record<string, Language> = {
  bash: 'bash',
  env: 'dotenv',
  html: 'html',
  js: 'javascript',
  jsx: 'jsx',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
};

export function HighlightedCode({
  code,
  language,
  size,
  wrap,
}: {
  code: string;
  language: string;
  size: CodeBlockSize;
  wrap: boolean;
}) {
  const theme = useShikiTheme();

  return (
    <ShikiHighlighter
      language={LANGUAGE_ALIAS[language.toLowerCase()] ?? 'text'}
      theme={theme}
      addDefaultStyles={false}
      showLanguage={false}
      className={`code-highlight mono${wrap ? ' code-wrap' : ''}`}
      style={{
        background: 'transparent',
        fontSize: size === 'sm' ? 11 : 12,
        lineHeight: 1.65,
      }}
    >
      {code.trim()}
    </ShikiHighlighter>
  );
}
