import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { shield as report } from '@/mocks/fixtures';
import { useShield } from '@/features/logs/hooks/useAdvisor';
import Advisor from './Advisor';

vi.mock('@/features/logs/hooks/useAdvisor', () => ({
  useShield: vi.fn(),
  usePerformance: () => ({ isFetching: false }),
}));
vi.mock('@/features/logs/components/PerformancePanel', () => ({ PerformancePanel: () => null }));

function renderAdvisor(data: typeof report | undefined, isError = false) {
  const refetch = vi.fn();
  vi.mocked(useShield).mockReturnValue({ data, isError, isLoading: false, isFetching: false, refetch } as unknown as ReturnType<typeof useShield>);
  render(<Advisor />);
  return refetch;
}

describe('Advisor', () => {
  it('starts with all findings, keeps critical actions open and filters categories', () => {
    renderAdvisor(report);
    const titles = screen.getAllByRole('heading', { level: 3 }).map(heading => heading.textContent);
    expect(titles).toEqual(report.recommendations.map(finding => finding.title));
    expect(screen.getByText('Enable RLS and add a SELECT policy.').closest('details')).toHaveAttribute('open');
    fireEvent.click(screen.getByRole('tab', { name: /Performance/ }));
    expect(screen.queryByText('RLS disabled on posts')).not.toBeInTheDocument();
    expect(screen.getByText('Sequential scans on users')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Operations/ }));
    expect(screen.getByText('No recommendations in this view')).toBeInTheDocument();
  });

  it('offers a retry instead of showing a healthy empty state when loading fails', () => {
    const refetch = renderAdvisor(undefined, true);
    expect(screen.getByRole('alert')).toHaveTextContent('Checks could not be loaded');
    expect(screen.queryByText('No recommendations in this view')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Scan summary')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('labels a previous report as stale when refreshing fails', () => {
    renderAdvisor(report, true);
    expect(screen.getByRole('alert')).toHaveTextContent('Showing the previous results');
    expect(screen.getByText('RLS disabled on posts')).toBeInTheDocument();
  });
});
