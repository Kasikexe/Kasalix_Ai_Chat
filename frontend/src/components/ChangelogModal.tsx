import { useEffect } from 'react';
import { ChangelogView } from './ChangelogView';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Full-screen modal that hosts the ChangelogView (release notes from GitHub). */
export function ChangelogModal({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl animate-fade-in overflow-hidden">
        <ChangelogView onClose={onClose} />
      </div>
    </div>
  );
}
