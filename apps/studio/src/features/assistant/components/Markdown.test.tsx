import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Markdown from './Markdown';

// CodeBlock pulls in a dynamic highlighter; the fence routing is what matters
// here, not how the block paints.
vi.mock('@/shared/ui/CodeBlock', () => ({
  CodeBlock: ({ value, label }: { value: string; label?: string }) => (
    <pre data-testid="code-block" data-label={label}>{value}</pre>
  ),
}));

describe('assistant Markdown', () => {
  it('renders a GFM table as a table, not as pipes', () => {
    // The reported symptom: an answer built around a comparison table arrived
    // as a wall of `|` and `---`, because tables are a GFM extension and the
    // old renderer printed the source verbatim.
    render(
      <Markdown>{['| path | views |', '|---|---|', '| `/` | 82 |'].join('\n')}</Markdown>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'path' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '82' })).toBeInTheDocument();
    expect(screen.queryByText(/\|---\|/)).not.toBeInTheDocument();
  });

  it('renders headings, bold and lists as elements', () => {
    render(<Markdown>{['## Conclusion', '', '- **719** of 805 events', ''].join('\n')}</Markdown>);

    expect(screen.getByText('Conclusion').tagName).toBe('H2');
    expect(screen.getByText('719').tagName).toBe('STRONG');
    expect(screen.getByRole('listitem')).toHaveTextContent('719 of 805 events');
  });

  it('sends a fenced block to CodeBlock and keeps inline code inline', () => {
    render(<Markdown>{['Run `SELECT 1` first:', '', '```sql', 'SELECT 2;', '```'].join('\n')}</Markdown>);

    const block = screen.getByTestId('code-block');
    expect(block).toHaveTextContent('SELECT 2;');
    expect(block.dataset.label).toBe('sql');
    expect(screen.getByText('SELECT 1').tagName).toBe('CODE');
  });

  it('opens a model-supplied link in a new tab without leaking the referrer', () => {
    render(<Markdown>{'[docs](https://example.com/docs)'}</Markdown>);

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });
});
