import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingOrb } from './ThinkingOrb';

describe('ThinkingOrb', () => {
  it('announces the wait when it is the only indicator', () => {
    render(<ThinkingOrb label="Running sql.query" />);
    expect(screen.getByRole('status')).toHaveAccessibleName('Running sql.query');
  });

  it('stays out of the accessibility tree when text beside it already says it', () => {
    const { container } = render(<ThinkingOrb />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
