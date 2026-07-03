import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Lock, WifiOff, Check, Circle } from 'lucide-react';
import type { OllamaModel } from '../types';
import { formatBytes } from '../utils/format';

interface Props {
  models: OllamaModel[];
  selected: string;
  onChange: (model: string) => void;
  getModelStatus: (name: string) => 'available' | 'hidden' | 'unavailable';
}

export function ModelSelector({ models, selected, onChange, getModelStatus }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const current = models.find((m) => m.name === selected);
  const currentStatus = selected ? getModelStatus(selected) : 'available';

  const statusInfo = (status: 'available' | 'hidden' | 'unavailable') => {
    switch (status) {
      case 'hidden':
        return {
          icon: <Lock size={11} />,
          label: 'Disabled by admin',
          textCls: 'text-amber-400',
          bgCls: 'bg-amber-900/30',
          clickable: false,
        };
      case 'unavailable':
        return {
          icon: <WifiOff size={11} />,
          label: 'Not loaded on server',
          textCls: 'text-red-400',
          bgCls: 'bg-red-900/20',
          clickable: false,
        };
      default:
        return {
          icon: <Check size={11} />,
          label: 'Available',
          textCls: 'text-emerald-400',
          bgCls: 'bg-emerald-900/30',
          clickable: true,
        };
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700 max-w-[220px]"
      >
        <Circle
          size={8}
          className={`flex-shrink-0 ${
            currentStatus === 'available' ? 'text-emerald-400 fill-emerald-400' :
            currentStatus === 'hidden' ? 'text-amber-400' : 'text-red-400'
          }`}
        />
        <span className="font-medium truncate">{current?.name || selected || 'Select'}</span>
        <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-gray-800 border border-gray-700 rounded-lg shadow-2xl z-50">
          {models.length === 0 ? (
            <p className="p-4 text-sm text-gray-400">No models installed.</p>
          ) : (
            <ul className="py-1">
              {models.map((m) => {
                const status = getModelStatus(m.name);
                const info = statusInfo(status);
                const isCurrent = m.name === selected;
                return (
                  <li key={m.name}>
                    <button
                      onClick={() => {
                        if (info.clickable) {
                          onChange(m.name);
                          setOpen(false);
                        }
                      }}
                      disabled={!info.clickable}
                      className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                        isCurrent ? 'bg-gray-700/50' : ''
                      } ${
                        info.clickable ? 'hover:bg-gray-700 cursor-pointer' : 'cursor-not-allowed opacity-70'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={info.textCls}>{info.icon}</span>
                        <span className={`font-medium truncate ${!info.clickable ? 'text-gray-400' : 'text-white'}`}>
                          {m.name}
                        </span>
                        {isCurrent && <span className="ml-auto text-xs text-blue-400">current</span>}
                      </div>
                      <div className="text-xs text-gray-500 flex gap-2 mt-0.5 ml-5 flex-wrap">
                        {m.size && <span>{formatBytes(m.size)}</span>}
                        {m.details?.parameter_size && <span>• {m.details.parameter_size}</span>}
                        {m.details?.quantization_level && <span>• {m.details.quantization_level}</span>}
                      </div>
                      <div className="text-xs mt-1 ml-5">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${info.bgCls} ${info.textCls}`}>
                          {info.label}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="px-4 py-2 border-t border-gray-700 text-xs text-gray-500">
            {models.length} model{models.length !== 1 ? 's' : ''} installed
          </div>
        </div>
      )}
    </div>
  );
}
