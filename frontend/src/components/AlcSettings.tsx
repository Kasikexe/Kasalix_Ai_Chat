import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen, FolderPlus, Trash2, RefreshCw, Database, Globe, AlertTriangle,
  CheckCircle2, Loader2, Gauge, FileText, Save, FolderOpen,
} from 'lucide-react';
import { api, type AlcIndexInfo, type AlcKnowledgeInfo } from '../services/api';
import { useToast } from '../hooks/useToast';

interface Props {
  /** Workspace of the open conversation — where ALC keeps `ALC/knowledge` (Koding) */
  workspacePath?: string;
}

const LIMITS = {
  cycles: { min: 1, max: 6 },
  toolCalls: { min: 1, max: 20 },
  tokens: { min: 500, max: 6000 },
  // Each written-up topic costs one extra model call after the answer, so 0 is a
  // legitimate (and cheap) choice: excerpts only, no writing-up.
  studyTopics: { min: 0, max: 5 },
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function when(seconds: number): string {
  if (!seconds) return 'never';
  try {
    return new Date(seconds * 1000).toLocaleString();
  } catch {
    return 'unknown';
  }
}

/**
 * ALC settings — what the cycle may read, where it may look, and how much work
 * per turn it may spend. Everything here is a server-side setting (the backend
 * owns the documentation index), so this panel reads and writes /api/settings.
 */
export function AlcSettings({ workspacePath }: Props) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'rebuild' | 'clear' | null>(null);

  const [paths, setPaths] = useState<string[]>([]);
  const [newPath, setNewPath] = useState('');
  const [webEnabled, setWebEnabled] = useState(true);
  const [writeKnowledge, setWriteKnowledge] = useState(true);
  const [maxCycles, setMaxCycles] = useState(3);
  const [maxToolCalls, setMaxToolCalls] = useState(12);
  const [maxTokens, setMaxTokens] = useState(4000);
  const [studyTopics, setStudyTopics] = useState(2);

  const [index, setIndex] = useState<AlcIndexInfo | null>(null);
  const [notes, setNotes] = useState<AlcKnowledgeInfo | null>(null);

  // Whether the host app has a Tavily (web search) key. Keys are entered in the
  // server app, not here: this panel only reports the state, so a switched-on web
  // search does not look silently broken. The key's value is never kept or shown.
  const [keySaved, setKeySaved] = useState(false);

  const loadIndex = useCallback(async () => {
    try {
      setIndex(await api.getAlcIndex());
    } catch {
      setIndex(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled) return;
        setPaths(Array.isArray(settings.alcDocsPaths) ? settings.alcDocsPaths : []);
        setWebEnabled(settings.alcWebEnabled !== false);
        setWriteKnowledge(settings.alcWriteKnowledge !== false);
        setMaxCycles(clamp(settings.alcMaxCycles ?? 3, LIMITS.cycles.min, LIMITS.cycles.max));
        setMaxToolCalls(clamp(settings.alcMaxToolCalls ?? 12, LIMITS.toolCalls.min, LIMITS.toolCalls.max));
        setMaxTokens(clamp(settings.alcMaxTokens ?? 4000, LIMITS.tokens.min, LIMITS.tokens.max));
        setStudyTopics(clamp(settings.alcStudyMaxTopics ?? 2, LIMITS.studyTopics.min, LIMITS.studyTopics.max));
        setKeySaved(Boolean((settings.tavilyApiKey || '').trim()));
      } catch {
        if (!cancelled) toast('error', 'Could not load the ALC settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
      await loadIndex();
    })();
    return () => { cancelled = true; };
  }, [loadIndex, toast]);

  useEffect(() => {
    let cancelled = false;
    if (!workspacePath) { setNotes(null); return; }
    (async () => {
      try {
        const info = await api.getAlcKnowledge(workspacePath);
        if (!cancelled) setNotes(info);
      } catch {
        if (!cancelled) setNotes(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workspacePath]);

  const save = async () => {
    setSaving(true);
    try {
      // The Tavily key is deliberately NOT part of this payload: it belongs to the
      // host app, and a client that could write it could also blank it.
      await api.saveSettings({
        alcDocsPaths: paths,
        alcWebEnabled: webEnabled,
        alcWriteKnowledge: writeKnowledge,
        alcMaxCycles: clamp(maxCycles, LIMITS.cycles.min, LIMITS.cycles.max),
        alcMaxToolCalls: clamp(maxToolCalls, LIMITS.toolCalls.min, LIMITS.toolCalls.max),
        alcMaxTokens: clamp(maxTokens, LIMITS.tokens.min, LIMITS.tokens.max),
        alcStudyMaxTopics: clamp(studyTopics, LIMITS.studyTopics.min, LIMITS.studyTopics.max),
      });
      toast('success', 'ALC settings saved');
      await loadIndex();
    } catch {
      toast('error', 'Could not save the ALC settings');
    }
    setSaving(false);
  };

  const rebuild = async () => {
    setBusy('rebuild');
    try {
      const result = await api.rebuildAlcIndex(true);
      if (result.ok) {
        toast('success', `Indexed ${result.status?.files ?? 0} file(s)`);
      } else {
        toast('error', result.error || 'Could not build the index');
      }
      await loadIndex();
    } catch {
      toast('error', 'Could not build the index');
    }
    setBusy(null);
  };

  const clear = async () => {
    setBusy('clear');
    try {
      await api.clearAlcIndex();
      toast('info', 'Documentation index cleared');
      await loadIndex();
    } catch {
      toast('error', 'Could not clear the index');
    }
    setBusy(null);
  };

  const addPath = () => {
    const value = newPath.trim().replace(/^"|"$/g, '');
    if (!value) return;
    if (paths.includes(value)) { setNewPath(''); return; }
    setPaths([...paths, value]);
    setNewPath('');
  };

  const numberField = (
    label: string,
    hint: string,
    value: number,
    setValue: (n: number) => void,
    limits: { min: number; max: number },
  ) => (
    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-800/50 border border-gray-800 rounded-xl">
      <div className="min-w-0">
        <p className="text-sm text-white">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
      </div>
      <input
        type="number"
        min={limits.min}
        max={limits.max}
        value={value}
        // Free while typing (clamping every keystroke would turn "3000" into 500
        // the moment the first digit lands) — the range is enforced on blur and
        // again on save, which is what the server does anyway.
        onChange={(e) => {
          const next = parseInt(e.target.value, 10);
          setValue(Number.isFinite(next) ? next : limits.min);
        }}
        onBlur={() => setValue(clamp(value, limits.min, limits.max))}
        className="w-20 px-2 py-1.5 bg-gray-900 border border-gray-700 rounded-lg text-sm text-white text-right outline-none focus:border-teal-600"
      />
    </div>
  );

  const toggle = (on: boolean, setOn: (v: boolean) => void, title: string, onText: string, offText: string, Icon: typeof Globe) => (
    <div
      onClick={() => setOn(!on)}
      className={`flex items-center justify-between px-4 py-3 rounded-xl cursor-pointer transition-all duration-200 ${
        on ? 'bg-teal-900/20 border border-teal-800/40' : 'bg-gray-800/50 border border-gray-800 hover:bg-gray-800'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-1.5 rounded-lg ${on ? 'bg-teal-700/30' : 'bg-gray-700/50'}`}>
          <Icon size={18} className={on ? 'text-teal-400' : 'text-gray-400'} />
        </div>
        <div>
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="text-xs text-gray-500 mt-0.5">{on ? onText : offText}</p>
        </div>
      </div>
      <div className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${on ? 'bg-teal-600' : 'bg-gray-700'}`}>
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`} />
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-6">
        <Loader2 size={14} className="animate-spin" /> Loading ALC settings…
      </div>
    );
  }

  const missing = index?.missing ?? [];

  return (
    <div key="tab-alc" className="space-y-6 animate-fade-in">
      {/* What ALC is */}
      <div className="px-4 py-3 bg-teal-900/10 border border-teal-900/40 rounded-xl">
        <div className="flex items-center gap-2">
          <BookOpen size={16} className="text-teal-400" />
          <h3 className="text-sm font-medium text-white">Advanced Learning Cycle</h3>
        </div>
        <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
          Turn ALC on per conversation with the <span className="text-teal-300">Normal | ALC</span> switch
          next to the message box. When it is on, the model looks things up — your documentation,
          the notes it saved for this project, and optionally the web — before it answers, and shows
          every step it took. Afterwards it writes up what it learned for the next session. Normal
          mode is untouched.
        </p>
      </div>

      {/* Documentation folders */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <FolderOpen size={16} className="text-[#4a9988]" />
          Documentation folders
        </label>
        <p className="text-xs text-gray-500 -mt-1">
          Markdown, text and code files in these folders become searchable. The index is built
          automatically the first time a cycle needs it.
        </p>

        <div className="flex items-center gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
            placeholder="C:\\Users\\me\\Documents\\library"
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-600 outline-none focus:border-teal-600"
          />
          <button
            onClick={addPath}
            disabled={!newPath.trim()}
            className="flex items-center gap-1.5 px-3 py-2 bg-teal-700 hover:bg-teal-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded-lg transition-colors"
          >
            <FolderPlus size={14} /> Add
          </button>
        </div>

        {paths.length === 0 ? (
          <p className="text-xs text-gray-500 px-1">
            No folders yet — ALC will only have project knowledge and (if enabled) the web.
          </p>
        ) : (
          <div className="space-y-1.5">
            {paths.map((path) => (
              <div
                key={path}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono ${
                  missing.includes(path)
                    ? 'bg-amber-900/10 border-amber-800/40 text-amber-200/80'
                    : 'bg-gray-800/50 border-gray-800 text-gray-300'
                }`}
              >
                {missing.includes(path) && <AlertTriangle size={12} className="text-amber-500 flex-shrink-0" />}
                <span className="flex-1 min-w-0 truncate" title={path}>{path}</span>
                {missing.includes(path) && <span className="text-[10px] text-amber-500/80 flex-shrink-0">not found</span>}
                <button
                  onClick={() => setPaths(paths.filter((p) => p !== path))}
                  className="p-1 hover:bg-gray-700/60 rounded text-gray-500 hover:text-red-400 transition-colors flex-shrink-0"
                  title="Remove this folder"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Index status */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Database size={16} className="text-[#4a9988]" />
          Documentation index
        </label>
        {index ? (
          <div className="px-4 py-3 bg-gray-800/50 border border-gray-800 rounded-xl space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
              <span className="flex items-center gap-1.5">
                {index.status.files > 0 ? <CheckCircle2 size={12} className="text-emerald-500" /> : <AlertTriangle size={12} className="text-gray-500" />}
                {index.status.files} file{index.status.files === 1 ? '' : 's'}
              </span>
              <span className="flex items-center gap-1.5"><FileText size={12} />{index.status.chunks} passages</span>
              <span>Built: {when(index.status.lastBuiltAt)}</span>
              <span className="text-gray-600">{index.roots.length} usable folder{index.roots.length === 1 ? '' : 's'}</span>
            </div>
            {!index.fts5 && (
              <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                This server's SQLite has no FTS5 — search falls back to scanning files (slower, no ranking).
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                onClick={rebuild}
                disabled={busy !== null || index.roots.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#2a3a52] hover:bg-[#345070] disabled:bg-gray-800 disabled:text-gray-600 text-white text-xs rounded-lg transition-colors"
              >
                {busy === 'rebuild' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {busy === 'rebuild' ? 'Indexing…' : 'Rebuild index'}
              </button>
              <button
                onClick={clear}
                disabled={busy !== null || index.status.files === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:text-gray-600 text-gray-300 text-xs rounded-lg transition-colors"
              >
                {busy === 'clear' ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Clear
              </button>
              <span className="text-[10px] text-gray-600 font-mono truncate" title={index.indexPath}>{index.indexPath}</span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Could not reach the ALC index endpoint.</p>
        )}
      </div>

      {/* Behaviour */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Globe size={16} className="text-[#4a9988]" />
          What ALC may do
        </label>
        {toggle(webEnabled, setWebEnabled, 'Search the web',
          keySaved
            ? 'Allowed — searches use the key saved in the server app'
            : 'Allowed, but the server app has no Tavily key yet',
          'Off — documentation and project knowledge only', Globe)}
        {toggle(writeKnowledge, setWriteKnowledge, 'Save what it learns',
          'Useful findings are written to ALC/knowledge for later sessions',
          'Nothing is written back to the project', Save)}
      </div>

      {/* Web search key — set on the host, only reported here */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Globe size={16} className="text-[#4a9988]" />
          Web search key
        </label>
        <p className="text-xs text-gray-500">
          Web search is powered by Tavily, and its key has one home: the server app's API keys.
          Every client uses the key saved there, so there is nothing to enter in this window and
          nothing here that could overwrite it. Free key at tavily.com; a basic search costs one of
          the monthly credits, and without a key ALC falls back to documentation and project notes.
          A key can be checked from the server app, which costs one search credit.
        </p>
        {webEnabled && !keySaved && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
            Web search is switched on but the server app has no Tavily key, so cycles stay offline.
          </p>
        )}
      </div>

      {/* Budget */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
          <Gauge size={16} className="text-[#4a9988]" />
          Per-turn budget
        </label>
        <p className="text-xs text-gray-500 -mt-1">
          Hard caps the software enforces, whatever the model asks for. Higher values mean more
          thorough answers and slower replies.
        </p>
        {numberField('Gather cycles', 'How many look-ups-then-judge rounds it may run', maxCycles, setMaxCycles, LIMITS.cycles)}
        {numberField('Look-ups per turn', 'Tool calls before it must answer with what it has', maxToolCalls, setMaxToolCalls, LIMITS.toolCalls)}
        {numberField('Working memory (tokens)', 'Evidence it may keep in front of the model', maxTokens, setMaxTokens, LIMITS.tokens)}
        {numberField('Topics written up per turn', 'How many topics it may rewrite into a project note after answering — each one is an extra model call, so it runs after the reply, never before it. 0 keeps raw excerpts only.', studyTopics, setStudyTopics, LIMITS.studyTopics)}
      </div>

      {/* Project knowledge */}
      {workspacePath && (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-gray-300">
            <BookOpen size={16} className="text-[#4a9988]" />
            Project knowledge
          </label>
          {notes?.available && notes.topics.length > 0 ? (
            <div className="space-y-1.5">
              {notes.topics.map((topic) => (
                <div key={topic.topic} className="flex items-center gap-3 px-3 py-2 bg-gray-800/50 border border-gray-800 rounded-lg">
                  <span className="flex-1 min-w-0 truncate text-xs text-gray-300" title={topic.title}>{topic.title}</span>
                  {Number(topic.studies ?? 0) > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/30 text-emerald-300 flex-shrink-0">
                      written up
                    </span>
                  )}
                  <span className="text-[10px] text-gray-500 flex-shrink-0">
                    {topic.notes} note{topic.notes === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
              <p className="text-[10px] text-gray-600 font-mono truncate">
                ALC/knowledge · {notes.stats.notes ?? 0} notes
                {Number(notes.stats.studies ?? 0) > 0 ? ` · ${notes.stats.studies} written up` : ''}
              </p>
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Nothing saved for this project yet — once a conversation with this folder open finds
              something worth keeping, it writes a note here and the next session starts from it.
            </p>
          )}
        </div>
      )}

      {/* Save */}
      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-teal-700 hover:bg-teal-600 disabled:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {saving ? 'Saving…' : 'Save ALC settings'}
        </button>
      </div>
    </div>
  );
}

export default AlcSettings;
