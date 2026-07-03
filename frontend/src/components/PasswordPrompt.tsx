import { useState } from 'react';
import { Lock, X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (password: string) => Promise<boolean>;
}

export function PasswordPrompt({ open, onClose, onSubmit }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const ok = await onSubmit(password);
    setSubmitting(false);
    if (ok) {
      setPassword('');
      onClose();
    } else {
      setError('Wrong password');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <Lock size={16} className="text-blue-400" />
            </div>
            <h2 className="text-lg font-semibold text-white">Settings Locked</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Enter the admin password to change which models are available.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 outline-none focus:border-gray-600"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!password || submitting}
              className="flex-1 px-3 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium"
            >
              {submitting ? 'Checking...' : 'Unlock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
