import type { PluginMode } from '../types';

/** Render only host-provided components; plugin data is never executed. */
export function PluginWelcome({ mode, onSend }: { mode: PluginMode; onSend?: (message: string, itemId: string) => void }) {
 return (
   <div className="plugin-welcome mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-5 py-8">
     <h2 className="text-2xl font-semibold">{mode.welcome.title}</h2>
     {mode.welcome.description && <p className="plugin-muted mt-2 max-w-xl text-sm leading-relaxed">{mode.welcome.description}</p>}
     {mode.welcome.items.length > 0 && (
       <div className="mt-6 grid gap-3 sm:grid-cols-2">
         {mode.welcome.items.map((item) => (
           <div key={item.id} className="plugin-card rounded-xl border p-4 text-left">
             <h3 className="font-medium">{item.label}</h3>
             {item.description && <p className="plugin-muted mt-1 text-sm leading-relaxed">{item.description}</p>}
             {item.message && onSend && <button type="button" onClick={() => onSend(item.message, item.id)} className="plugin-action mt-3 rounded-lg px-3 py-1.5 text-xs font-semibold">Start</button>}
           </div>
         ))}
       </div>
     )}
   </div>
 );
}
