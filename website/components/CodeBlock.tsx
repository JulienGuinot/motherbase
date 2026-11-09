import { CodeSnippet } from './CodeSnippet'
import { highlightCode } from '@/lib/code-theme'

interface CodeBlockProps {
  code: string
  lang?: string
}

export async function CodeBlock({ code, lang = 'bash' }: CodeBlockProps) {
  const html = await highlightCode(code, lang)

  return <CodeSnippet html={html} code={code} className="code-snippet--framed" />
}
