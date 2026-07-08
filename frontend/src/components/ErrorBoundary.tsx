import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex items-center justify-center p-8 min-h-[200px]">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 mx-auto rounded-xl bg-red-900/30 border border-red-800/50 flex items-center justify-center mb-3">
              <AlertTriangle size={24} className="text-red-400" />
            </div>
            <h3 className="text-base font-semibold text-gray-200 mb-1">Something went wrong</h3>
            <p className="text-xs text-gray-500 mb-3 font-mono break-all max-h-16 overflow-y-auto">
              {this.state.error?.message || 'Unknown error'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium rounded-lg transition-colors border border-gray-700"
            >
              <RefreshCw size={12} />
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
