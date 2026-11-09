import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Mascot } from '@/shared/ui/Mascot';
import { CodeBlock } from '@/shared/ui/CodeBlock';

// Without this, any render-time exception unmounts the whole tree and leaves a
// white page with the reason visible only in the devtools console. This keeps a
// readable screen with the two things a user can act on: retry, and the error
// text to paste into a report.

interface Props {
  children: ReactNode;
  /** Shown instead of the default screen, e.g. to keep the app chrome around. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the component stack in the console; it is the only place it exists.
    console.error('Studio render error', error, info.componentStack);
  }

  private reset = (): void => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <Mascot name="bug" size={104} />
        <div className="space-y-1.5">
          <p className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
            This screen ran into an error
          </p>
          <p className="mx-auto max-w-[420px] text-[12px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
            The rest of the console is unaffected. Try again, and if it keeps happening include the
            detail below in your report.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={this.reset}>
            Try again
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload console
          </button>
        </div>
        <CodeBlock
          value={error.message || String(error)}
          label="Error detail"
          tone="danger"
          size="sm"
          maxHeight={240}
          wrap
          className="w-full max-w-[560px] text-left"
        />
      </div>
    );
  }
}
