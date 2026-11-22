import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError } from '../lib/update';

interface Props {
  children: ReactNode;
  /** A new value (e.g. the page's address) clears the error. */
  resetKey?: string;
}

/** Shows what went wrong, with a way out, instead of a blank page. */
export class ErrorBoundary extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Athena-sky: page failed', error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const update = isChunkLoadError(error);
    const detail = error instanceof Error ? error.message : String(error);
    return (
      <div className="content">
        <div className="not-found" role="alert" data-testid="page-error">
          <h1>{update ? 'Athena-sky has been updated' : 'This page could not be shown'}</h1>
          <p className="muted">{update ? 'Reload to continue with the new version.' : `Something went wrong: ${detail}`}</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
