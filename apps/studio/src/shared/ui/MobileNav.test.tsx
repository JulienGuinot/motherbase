import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Database, Home } from 'lucide-react';
import MobileNav from './MobileNav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/p/demo/database',
}));

const items = [
  { href: '/p/demo', label: 'Overview', icon: Home, end: true },
  { href: '/p/demo/database', label: 'Database', icon: Database },
];

describe('MobileNav', () => {
  it('keeps the menu and its action together in the pill, and the list closed', () => {
    render(<MobileNav title="Motherbase" items={items} action={<button type="button">Assistant</button>} />);

    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Motherbase' })).not.toBeInTheDocument();
  });

  it('opens the sheet and closes it once a destination is picked', () => {
    render(<MobileNav title="Motherbase" items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('navigation', { name: 'Motherbase' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Overview' }));
    expect(screen.queryByRole('navigation', { name: 'Motherbase' })).not.toBeInTheDocument();
  });

  it('closes the sheet on Escape', () => {
    render(<MobileNav title="Motherbase" items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('navigation', { name: 'Motherbase' })).not.toBeInTheDocument();
  });
});
