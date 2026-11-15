import { useState } from 'react';
import { Brain, X } from 'lucide-react';
import { api } from '../services/api';

export function PluginMemory({ conversationId, label }: { conversationId: string; label: string }) {
 const [open, setOpen] = useState(false);
 const [memory, setMemory] = useState<{ enabled: boolean; categories: Record<string, Record<string, string>> } | null>(null);
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);

 const show = async () => {
   setOpen(true); setError(''); setBusy(true);
   try { setMemory(await api.getPluginMemory(conversationId)); }
   catch { setError('Could not load memory.'); }
   finally { setBusy(false); }
 };
 const clear = async () => {
   if (!window.confirm(`Clear the saved memory for ${label}?`)) return;
   setBusy(true); setError('');
   try { await api.clearPluginMemory(conversationId); setMemory((value) => value ? { ...value, categories: {} } : value); }
   catch { setError('Could not clear memory.'); }
   finally { setBusy(false); }
 };
 return <>
   <button type="button" onClick={show} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-400 hover:bg-gray-800 hover:text-gray-200"><Brain size={12}/> Memory</button>
   {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(false)}>
     <div role="dialog" aria-modal="true" aria-label={`Memory for ${label}`} onClick={(event) => event.stopPropagation()} className="w-full max-w-md rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-xl">
       <div className="flex items-center justify-between gap-3"><h2 className="font-semibold text-white">Memory · {label}</h2><button type="button" onClick={() => setOpen(false)} aria-label="Close memory"><X size={18}/></button></div>
       <p className="mt-2 text-xs leading-relaxed text-gray-400">Saved separately for this selection. Manage the overall Memory setting in your preferences.</p>
       {memory && !memory.enabled && <p className="mt-3 text-xs text-amber-300">Memory is off in settings. Saved details will not be used until it is enabled.</p>}
       {busy && <p className="mt-4 text-sm text-gray-400">Loading…</p>}
       {error && <p className="mt-4 text-sm text-red-300">{error}</p>}
       {memory && <div className="mt-4 max-h-64 space-y-3 overflow-auto text-sm">
         {Object.entries(memory.categories).length === 0 ? <p className="text-gray-400">No saved details yet.</p> : Object.entries(memory.categories).map(([category, entries]) => <div key={category}>
           <h3 className="font-medium text-gray-200">{category}</h3>
           {Object.entries(entries).map(([key, value]) => <p key={key} className="mt-1 break-words text-gray-400">{key}: {value}</p>)}
         </div>)}
       </div>}
       {memory && Object.keys(memory.categories).length > 0 && <button type="button" disabled={busy} onClick={clear} className="mt-4 rounded-lg border border-red-700/60 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50">Clear memory</button>}
     </div>
   </div>}
 </>;
}
