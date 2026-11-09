'use client';

import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from '@/shared/ui/CodeBlock';

/**
 * The assistant's answers, rendered as markdown.
 *
 * The models answer in markdown whether or not anyone asked them to: headings,
 * GFM tables, bullet lists, bold. This used to print the source verbatim in a
 * `whitespace-pre-wrap` paragraph, so an answer built around a comparison table
 * arrived as a wall of pipes and hyphens.
 *
 * remark-gfm is not optional here: tables and strikethrough are the two things
 * that read worst unrendered, and both are GFM extensions rather than core
 * markdown.
 *
 * The typography lives in the `.md` block of index.css, not in this file. The
 * rules that matter are structural (a table's last row loses its rule, the
 * heading that opens an answer loses its top margin, a list item's own
 * paragraphs lose the block gap) and none of them can be written as an inline
 * style on a react-markdown component. Only the two elements that need real
 * behaviour are overridden here: a fenced block becomes a CodeBlock, and a
 * table gets its scroll box.
 */

/** Concatenate a node tree's text, for handing a fenced block to CodeBlock. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

const COMPONENTS: Components = {
  // The fence is unwrapped: CodeBlock draws its own container, and leaving the
  // <pre> around it would nest a scroll region inside a scroll region.
  pre: ({ children }) => <>{children}</>,

  code: ({ className, children }) => {
    const language = /language-(\w+)/.exec(className ?? '')?.[1];
    const body = textOf(children);
    // react-markdown no longer passes `inline`: a fenced block is the one that
    // carries a language, or that spans more than one line.
    if (!language && !body.includes('\n')) return <code>{children}</code>;
    return (
      <CodeBlock
        value={body.replace(/\n$/, '')}
        label={language ?? 'Code'}
        language={language}
        size="sm"
        maxHeight={280}
      />
    );
  },

  // Answers about a schema or a job history are mostly tables, and the dock is a
  // narrow column: the box scrolls sideways rather than squeezing the columns.
  table: ({ children }) => (
    <div className="md-table-scroll">
      <table>{children}</table>
    </div>
  ),

  // Anything the model links to is outside this console; it opens in its own
  // tab and carries no referrer.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),

  // Never fetch a URL the model invented, and never leave a broken image frame
  // in the middle of an answer.
  img: ({ alt }) => <span style={{ color: 'var(--text-mute)' }}>{alt || 'image'}</span>,
};

export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
