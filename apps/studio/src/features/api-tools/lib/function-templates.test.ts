import { describe, expect, it } from 'vitest';
import { FUNCTION_TEMPLATES, renderFunctionTemplate } from '@/features/api-tools/lib/function-templates';

describe('function templates', () => {
  it('has unique ids and module-shaped sources', () => {
    expect(new Set(FUNCTION_TEMPLATES.map(t => t.id)).size).toBe(FUNCTION_TEMPLATES.length);
    for (const template of FUNCTION_TEMPLATES) expect(template.source).toContain('export default');
  });

  it('renders the function name, with a fallback while it is still empty', () => {
    const hello = FUNCTION_TEMPLATES[0];
    expect(renderFunctionTemplate(hello, 'greet')).toContain('Edge function: greet');
    expect(renderFunctionTemplate(hello, '')).toContain('Edge function: my-function');
    expect(renderFunctionTemplate(hello, 'greet')).not.toContain('%NAME%');
  });
});
