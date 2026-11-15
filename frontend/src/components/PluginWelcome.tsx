import type { PluginMode } from '../types';
import { useState } from 'react';
import { api } from '../services/api';

type Item = PluginMode['welcome']['items'][number];

function PluginCard({ item, mode, onSend }: { item: Item; mode: PluginMode; onSend?: (message: string, itemId: string) => void }) {
 const [result, setResult] = useState<string | null>(null);
 const [busy, setBusy] = useState(false);
 const run = async () => {
   if (!item.backendAction || busy) return;
   setBusy(true); setResult(null);
   try {
     const response = await api.invokePluginAction(mode.pluginId, item.backendAction, item.payload || {});
     setResult(typeof response === 'string' ? response : JSON.stringify(response, null, 2) ?? 'Done');
   } catch (error) { setResult(error instanceof Error ? error.message : 'Action failed'); }
   finally { setBusy(false); }
 };
 return <div className="plugin-card rounded-xl border p-4 text-left">
   <h3 className="font-medium">{item.label}</h3>
   {item.description && <p className="plugin-muted mt-1 text-sm leading-relaxed">{item.description}</p>}
   {item.message && onSend && <button type="button" onClick={() => onSend(item.message, item.id)} className="plugin-action mt-3 rounded-lg px-3 py-1.5 text-xs font-semibold">Start</button>}
   {item.backendAction && <button type="button" onClick={run} disabled={busy} className="plugin-action mt-3 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{busy ? 'Running…' : 'Run'}</button>}
   {result !== null && <pre className="plugin-muted mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">{result}</pre>}
 </div>;
}

/** Render only host-provided components; plugin data is never executed. */
export function PluginWelcome({ mode, onSend }: { mode: PluginMode; onSend?: (message: string, itemId: string) => void }) {
 const [clearStatus, setClearStatus] = useState('');
 const clearStorage = async () => {
   if (!window.confirm('Clear your saved data for this plugin?')) return;
   try { await api.clearPluginStorage(mode.pluginId); setClearStatus('Plugin data cleared.'); }
   catch (error) { setClearStatus(error instanceof Error ? error.message : 'Could not clear plugin data.'); }
 };
 return (
   <div className="plugin-welcome mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-5 py-8">
     <h2 className="text-2xl font-semibold">{mode.welcome.title}</h2>
     {mode.welcome.description && <p className="plugin-muted mt-2 max-w-xl text-sm leading-relaxed">{mode.welcome.description}</p>}
     {mode.welcome.items.length > 0 && (
       <div className="mt-6 grid gap-3 sm:grid-cols-2">
         {mode.welcome.items.map((item) => <PluginCard key={item.id} item={item} mode={mode} onSend={onSend} />)}
       </div>
     )}
     {mode.welcome.items.some((item) => item.backendAction) && <div className="mt-4 flex items-center gap-3 text-xs">
       <button type="button" onClick={clearStorage} className="plugin-muted underline">Clear plugin data</button>
       {clearStatus && <span className="plugin-muted">{clearStatus}</span>}
     </div>}
   </div>
 );
}
