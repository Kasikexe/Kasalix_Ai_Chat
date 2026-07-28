import { useState, useEffect, useCallback } from 'react';
import { Activity, Zap, Clock, Gauge, BarChart3, X, Trash2, Loader, Play, TrendingUp, Calendar, Cpu, CheckCircle2, XCircle, Layers } from 'lucide-react';
import { api } from '../services/api';

interface QualityCheckResult {
  name: string;
  passed: boolean;
  details?: string;
}

interface SingleTestResult {
  testId: string;
  testName: string;
  category: string;
  assignmentKey: string;
  success: boolean;
  totalTimeMs: number;
  timeToFirstTokenMs: number;
  totalChars: number;
  estimatedTokens: number;
  tokensPerSecond: number;
  model: string;
  error?: string;
  timestamp: number;
  qualityScore: number;
  qualityChecks: QualityCheckResult[];
}

interface ModelSummary {
  model: string;
  label: string;
  icon: string;
  tests: number;
  passed: number;
  failed: number;
  avgResponseTimeMs: number;
  avgTokensPerSecond: number;
  avgQualityScore: number;
}

interface SpeedTestRunResult {
  id: string;
  date: string;
  timestamp: number;
  totalDurationMs: number;
  models: Record<string, string>;
  modelCount: number;
  tests: SingleTestResult[];
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    avgResponseTimeMs: number;
    avgTokensPerSecond: number;
    avgTimeToFirstTokenMs: number;
    avgQualityScore: number;
  };
  modelSummaries: Record<string, ModelSummary>;
}

const MODEL_COLORS: Record<string, { bg: string; border: string; text: string; gradient: string }> = {
  chat_fast: {
    bg: 'bg-emerald-900/30', border: 'border-emerald-700/40', text: 'text-emerald-400',
    gradient: 'from-emerald-500 to-emerald-400',
  },
  chat_thinking: {
    bg: 'bg-purple-900/30', border: 'border-purple-700/40', text: 'text-purple-400',
    gradient: 'from-purple-500 to-purple-400',
  },
  code: {
    bg: 'bg-blue-900/30', border: 'border-blue-700/40', text: 'text-blue-400',
    gradient: 'from-blue-500 to-blue-400',
  },
  vision: {
    bg: 'bg-amber-900/30', border: 'border-amber-700/40', text: 'text-amber-400',
    gradient: 'from-amber-500 to-amber-400',
  },
  search: {
    bg: 'bg-cyan-900/30', border: 'border-cyan-700/40', text: 'text-cyan-400',
    gradient: 'from-cyan-500 to-cyan-400',
  },
  extraction: {
    bg: 'bg-rose-900/30', border: 'border-rose-700/40', text: 'text-rose-400',
    gradient: 'from-rose-500 to-rose-400',
  },
};

function getModelStyle(key: string) {
  return MODEL_COLORS[key] || {
    bg: 'bg-gray-900/30', border: 'border-gray-700/40', text: 'text-gray-400',
    gradient: 'from-gray-500 to-gray-400',
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return `Today, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  if (diff < 172800000) return `Yesterday, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Detail Modal ──────────────────────────────────────────

function DetailModal({ result, onClose }: { result: SpeedTestRunResult; onClose: () => void }) {
  const maxResponseTime = Math.max(...result.tests.map((t) => t.totalTimeMs), 1);
  const maxTps = Math.max(...result.tests.map((t) => t.tokensPerSecond), 1);

  const getScoreColor = (score: number, max: number, invert: boolean = false) => {
    const ratio = invert ? 1 - score / max : score / max;
    if (ratio > 0.7) return 'bg-emerald-500';
    if (ratio > 0.4) return 'bg-amber-500';
    return 'bg-red-500';
  };

  // Group tests by model key for section rendering
  const modelGroups: Record<string, SingleTestResult[]> = {};
  for (const test of result.tests) {
    if (!modelGroups[test.assignmentKey]) modelGroups[test.assignmentKey] = [];
    modelGroups[test.assignmentKey].push(test);
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center animate-fade-in p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Activity size={20} className="text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Speed Test Results</h2>
              <p className="text-xs text-gray-400">{formatDate(result.date)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-white transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Summary Cards Row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Clock size={14} /> Total Duration
              </div>
              <p className="text-xl font-bold text-white">{formatDuration(result.totalDurationMs)}</p>
            </div>
            <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Layers size={14} /> Models Tested
              </div>
              <p className="text-xl font-bold text-white">{result.modelCount}</p>
            </div>
            <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Zap size={14} /> Avg Response
              </div>
              <p className="text-xl font-bold text-white">{formatDuration(result.summary.avgResponseTimeMs)}</p>
            </div>
            <div className="bg-gray-800/60 rounded-xl p-4 border border-gray-700/50">
              <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
                <Activity size={14} /> Avg Quality
              </div>
              <p className={`text-xl font-bold ${result.summary.avgQualityScore >= 70 ? 'text-yellow-400' : result.summary.avgQualityScore >= 40 ? 'text-orange-400' : 'text-red-400'}`}>
                {result.summary.avgQualityScore}%
              </p>
            </div>
          </div>

          {/* Per-Model Summary Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(result.modelSummaries).map(([key, ms]) => {
              const style = getModelStyle(key);
              return (
                <div key={key} className={`rounded-xl p-3 border ${style.border} ${style.bg}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-sm">{ms.icon}</span>
                    <span className="text-xs font-medium text-gray-200">{ms.label}</span>
                  </div>
                  <p className="text-[10px] text-gray-500 mb-2 font-mono truncate">{ms.model}</p>                    <div className="flex items-center gap-3">
                      <div>
                        <span className="text-sm font-bold text-white">{formatDuration(ms.avgResponseTimeMs)}</span>
                        <span className="text-[9px] text-gray-500 ml-1">avg</span>
                      </div>
                      <div>
                        <span className="text-sm font-bold text-blue-400">{ms.avgTokensPerSecond.toFixed(1)}</span>
                        <span className="text-[9px] text-gray-500 ml-1">tok/s</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`text-xs font-bold ${ms.failed === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {ms.passed}/{ms.tests}
                        </span>
                        <span className={`text-[10px] font-bold ${ms.avgQualityScore >= 70 ? 'text-yellow-400' : ms.avgQualityScore >= 40 ? 'text-orange-400' : 'text-red-400'}`}>
                          · {ms.avgQualityScore}%
                        </span>
                      </div>
                    </div>
                </div>
              );
            })}
          </div>

          {/* Response Time Bar Chart — grouped by model */}
          <div className="bg-gray-800/40 rounded-xl p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
              <BarChart3 size={14} /> Response Time by Test (grouped by model)
            </div>
            <div className="space-y-4">
              {Object.entries(modelGroups).map(([key, groupTests]) => {
                const style = getModelStyle(key);
                return (
                  <div key={key}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`w-2 h-2 rounded-full ${style.text} bg-current`} />
                      <span className="text-xs font-medium text-gray-300">
                        {result.modelSummaries[key]?.label || key}
                      </span>
                      <span className="text-[9px] text-gray-600 font-mono">({result.modelSummaries[key]?.model})</span>
                    </div>
                    <div className="space-y-2 pl-3">
                      {groupTests.map((test) => {
                        const widthPct = (test.totalTimeMs / maxResponseTime) * 100;
                        const color = getScoreColor(test.totalTimeMs, maxResponseTime, true);
                        return (
                          <div key={test.testId} className="space-y-0.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-300">{test.testName}</span>
                              <span className="text-gray-400 font-mono">{formatDuration(test.totalTimeMs)}</span>
                            </div>
                            <div className="w-full h-2.5 bg-gray-700/50 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${color} ${test.success ? '' : 'opacity-40'}`}
                                style={{ width: `${widthPct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tokens Per Second Chart — grouped by model */}
          <div className="bg-gray-800/40 rounded-xl p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
              <TrendingUp size={14} /> Tokens per Second by Test
            </div>
            <div className="space-y-4">
              {Object.entries(modelGroups).map(([key, groupTests]) => {
                const style = getModelStyle(key);
                return (
                  <div key={key}>
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className={`w-2 h-2 rounded-full ${style.text} bg-current`} />
                      <span className="text-xs font-medium text-gray-300">
                        {result.modelSummaries[key]?.label || key}
                      </span>
                    </div>
                    <div className="space-y-2 pl-3">
                      {groupTests.map((test) => {
                        const widthPct = (test.tokensPerSecond / maxTps) * 100;
                        const color = getScoreColor(test.tokensPerSecond, maxTps);
                        return (
                          <div key={test.testId} className="space-y-0.5">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-gray-300">{test.testName}</span>
                              <span className="text-gray-400 font-mono">{test.tokensPerSecond.toFixed(1)} tok/s</span>
                            </div>
                            <div className="w-full h-2.5 bg-gray-700/50 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${widthPct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Quality Score Bar Chart */}
          <div className="bg-gray-800/40 rounded-xl p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 text-xs text-gray-400 mb-4">
              <Activity size={14} /> Quality Score by Test — click row to see check details
            </div>
            <div className="space-y-2">
              {result.tests.map((test) => {
                const qScore = test.qualityScore ?? 0;
                const qColor = qScore >= 70 ? 'bg-yellow-400' : qScore >= 40 ? 'bg-orange-400' : 'bg-red-400';
                const style = getModelStyle(test.assignmentKey);
                const checks = test.qualityChecks || [];
                return (
                  <div key={test.testId} className="group">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${style.text} bg-current`} />
                        <span className="text-gray-300">{test.testName}</span>
                        <span className={`text-[9px] px-1 py-0.5 rounded ${style.bg} ${style.text}`}>
                          {result.modelSummaries[test.assignmentKey]?.label || test.assignmentKey}
                        </span>
                      </div>
                      <span className={`font-mono font-bold ${qScore >= 70 ? 'text-yellow-400' : qScore >= 40 ? 'text-orange-400' : 'text-red-400'}`}>
                        {qScore}%
                      </span>
                    </div>
                    <div className="w-full h-2 bg-gray-700/50 rounded-full overflow-hidden mt-1">
                      <div className={`h-full rounded-full transition-all ${qColor}`} style={{ width: `${qScore}%` }} />
                    </div>
                    {/* Quality checks detail — visible on hover */}
                    {checks.length > 0 && (
                      <div className="mt-1.5 space-y-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {checks.map((check, ci) => (
                          <div key={ci} className="flex items-center gap-1.5 text-[10px]">
                            {check.passed
                              ? <span className="text-emerald-400">✓</span>
                              : <span className="text-red-400">✗</span>
                            }
                            <span className={check.passed ? 'text-gray-400' : 'text-gray-500'}>{check.name}</span>
                            {check.details && (
                              <span className={`${check.passed ? 'text-gray-600' : 'text-red-400/60'}`}>— {check.details}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Detailed Test Table */}
          <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-700/50">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">All Test Details</span>
            </div>
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-800">
                  <tr className="border-b border-gray-700/50 text-gray-500">
                    <th className="text-left px-4 py-2 font-medium">Test</th>
                    <th className="text-left px-4 py-2 font-medium">Model</th>
                    <th className="text-right px-4 py-2 font-medium">Status</th>
                    <th className="text-right px-4 py-2 font-medium">Time</th>
                    <th className="text-right px-4 py-2 font-medium">TTFB</th>
                    <th className="text-right px-4 py-2 font-medium">Chars</th>
                    <th className="text-right px-4 py-2 font-medium">Tok/s</th>
                    <th className="text-right px-4 py-2 font-medium">Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {result.tests.map((test) => {
                    const style = getModelStyle(test.assignmentKey);
                    const qScore = test.qualityScore ?? 0;
                    const qColor = qScore >= 70 ? 'text-yellow-400' : qScore >= 40 ? 'text-orange-400' : 'text-red-400';
                    return (
                      <tr key={test.testId} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                        <td className="px-4 py-2.5 text-gray-200">{test.testName}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${style.bg} ${style.text}`}>
                            {result.modelSummaries[test.assignmentKey]?.label || test.assignmentKey}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {test.success
                            ? <CheckCircle2 size={14} className="text-emerald-400 inline-block" />
                            : <XCircle size={14} className="text-red-400 inline-block" />
                          }
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-300">{formatDuration(test.totalTimeMs)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-400">{formatDuration(test.timeToFirstTokenMs)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-400">{test.totalChars}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-gray-300">{test.tokensPerSecond.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <div className="w-12 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${qScore >= 70 ? 'bg-yellow-400' : qScore >= 40 ? 'bg-orange-400' : 'bg-red-400'}`} style={{ width: `${qScore}%` }} />
                            </div>
                            <span className={`font-mono text-[10px] ${qColor}`}>{qScore}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {result.tests.some((t) => !t.success) && (
            <div className="bg-red-900/20 border border-red-800/30 rounded-xl p-4">
              <p className="text-xs font-medium text-red-400 mb-2">Errors</p>
              {result.tests.filter((t) => !t.success).map((test) => (
                <p key={test.testId} className="text-xs text-red-300/80 mb-1">
                  <strong>{test.testName} ({result.modelSummaries[test.assignmentKey]?.label}):</strong> {test.error || 'Unknown error'}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────

export function SpeedTestView({ isAdmin = false }: { isAdmin?: boolean }) {
  const [results, setResults] = useState<SpeedTestRunResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [selectedResult, setSelectedResult] = useState<SpeedTestRunResult | null>(null);

  // Sanitize results: old-format results may lack new fields
  const sanitize = (r: any): SpeedTestRunResult => ({
    ...r,
    modelSummaries: Object.fromEntries(
      Object.entries(r.modelSummaries || {}).map(([k, v]: [string, any]) => [k, { ...v, avgQualityScore: v.avgQualityScore ?? 0 }])
    ),
    models: r.models || {},
    modelCount: r.modelCount ?? Object.keys(r.modelSummaries || {}).length ?? 0,
    summary: { ...r.summary, avgQualityScore: r.summary?.avgQualityScore ?? 0 },
    tests: (r.tests || []).map((t: any) => ({
      ...t,
      qualityScore: t.qualityScore ?? 0,
      qualityChecks: t.qualityChecks || [],
    })),
  });

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getSpeedTestResults();
      setResults((data.results || []).map(sanitize));
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  const handleRunTests = async () => {
    if (running) return;
    setRunning(true);
    try {
      await api.runSpeedTests();
      await fetchResults();
    } catch (e) {
      console.error('Speed test failed:', e);
    }
    setRunning(false);
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteSpeedTestResult(id);
      await fetchResults();
    } catch { /* ignore */ }
  };

  const latestResult = results[0];

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/50">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-emerald-400" />
          <h2 className="text-sm font-medium text-gray-200">Speed Test</h2>
          {latestResult && (
            <span className="text-[10px] text-gray-600 font-mono">
              {latestResult.summary.passed}/{latestResult.summary.totalTests} passed
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button
              onClick={handleRunTests}
              disabled={running}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-emerald-600/20 active:scale-95"
            >
              {running ? (
                <Loader size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              {running ? 'Running tests...' : 'Run All Tests'}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader size={20} className="animate-spin text-gray-500" />
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-4">
            <Activity size={40} className="text-gray-700 mb-3" />
            <p className="text-sm text-gray-500 mb-1">No speed test results yet</p>
            {isAdmin && (
              <p className="text-xs text-gray-600">Click "Run All Tests" to benchmark all your AI models</p>
            )}
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-[26px] top-0 bottom-0 w-px bg-gradient-to-b from-emerald-500/30 via-gray-700/50 to-gray-800" />

            <div className="py-4 space-y-0">
              {results.map((result, idx) => {
                const isLatest = idx === 0;
                const avgColor = result.summary.avgResponseTimeMs < 5000 ? 'text-emerald-400' :
                  result.summary.avgResponseTimeMs < 15000 ? 'text-amber-400' : 'text-red-400';

                return (
                  <div key={result.id} className="relative group">
                    <div className={`absolute left-[18px] top-6 w-[17px] h-[17px] rounded-full border-2 z-10 flex items-center justify-center transition-all cursor-pointer ${
                      isLatest
                        ? 'border-emerald-400 bg-emerald-900/50 shadow-[0_0_8px_rgba(52,211,153,0.3)]'
                        : 'border-gray-600 bg-gray-800 group-hover:border-gray-500'
                    }`}>
                      <div className={`w-1.5 h-1.5 rounded-full ${isLatest ? 'bg-emerald-400' : 'bg-gray-500'}`} />
                    </div>

                    <div
                      onClick={() => setSelectedResult(result)}
                      className={`ml-12 mr-4 mb-3 rounded-xl border transition-all cursor-pointer ${
                        isLatest
                          ? 'bg-gradient-to-br from-emerald-600/5 via-emerald-900/5 to-transparent border-emerald-700/30 shadow-lg shadow-emerald-900/10 hover:border-emerald-600/50'
                          : 'bg-gray-900/40 border-gray-800 hover:border-gray-700 hover:bg-gray-900/60'
                      }`}
                    >
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-800 border border-gray-700 text-gray-300">
                              <Calendar size={10} />
                              {formatDate(result.date)}
                            </div>
                            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-800 border border-gray-700 text-gray-400">
                              <Layers size={10} />
                              {result.modelCount} models
                            </div>
                            {isLatest && (
                              <span className="text-[9px] font-medium text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded-full">Latest</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {isAdmin && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDelete(result.id); }}
                                className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-red-900/20 opacity-0 group-hover:opacity-100 transition-all"
                              ><Trash2 size={12} /></button>
                            )}
                          </div>
                        </div>

                        {/* Model badges row */}
                        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                          {Object.entries(result.modelSummaries).map(([key, ms]) => {
                            const style = getModelStyle(key);
                            return (
                              <span key={key} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ${style.bg} ${style.text} ${style.border} border`}>
                                {ms.icon} {ms.label}: {formatDuration(ms.avgResponseTimeMs)}
                              </span>
                            );
                          })}
                        </div>

                        {/* Quick summary row */}
                        <div className="flex items-center gap-4 mt-3 flex-wrap">
                          <div className="flex items-center gap-1.5">
                            <Clock size={12} className="text-gray-500" />
                            <span className={`text-sm font-bold font-mono ${avgColor}`}>
                              {result.summary.avgResponseTimeMs < 1000
                                ? `${result.summary.avgResponseTimeMs}ms`
                                : `${(result.summary.avgResponseTimeMs / 1000).toFixed(1)}s`}
                            </span>
                            <span className="text-[10px] text-gray-500">avg</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Gauge size={12} className="text-gray-500" />
                            <span className="text-sm font-bold font-mono text-blue-400">
                              {result.summary.avgTokensPerSecond.toFixed(1)}
                            </span>
                            <span className="text-[10px] text-gray-500">tok/s</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Zap size={12} className="text-gray-500" />
                            <span className="text-sm font-bold font-mono text-amber-400">
                              {formatDuration(result.summary.avgTimeToFirstTokenMs)}
                            </span>
                            <span className="text-[10px] text-gray-500">TTFB</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-xs font-bold ${result.summary.failed === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {result.summary.passed}/{result.summary.totalTests}
                            </span>
                            <span className="text-[10px] text-gray-500">passed</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className={`text-xs font-bold ${result.summary.avgQualityScore >= 70 ? 'text-yellow-400' : result.summary.avgQualityScore >= 40 ? 'text-orange-400' : 'text-red-400'}`}>
                              {result.summary.avgQualityScore}%
                            </span>
                            <span className="text-[10px] text-gray-500">quality</span>
                          </div>
                        </div>

                        {/* Mini bar chart preview — color-coded by model */}
                        <div className="flex items-end gap-1 mt-3 h-6">
                          {result.tests.map((test) => {
                            const heightPct = Math.max(15, (test.totalTimeMs / Math.max(...result.tests.map((t) => t.totalTimeMs))) * 100);
                            const style = getModelStyle(test.assignmentKey);
                            return (
                              <div
                                key={test.testId}
                                className="flex-1 rounded-t transition-all group-hover:opacity-100"
                                style={{
                                  height: `${heightPct}%`,
                                  background: test.success
                                    ? `linear-gradient(to top, ${style.gradient})`
                                    : `linear-gradient(to top, rgb(239,68,68), rgb(220,38,38))`,
                                  opacity: test.success ? 0.7 : 0.5,
                                  minHeight: '4px',
                                }}
                                title={`${test.testName}: ${formatDuration(test.totalTimeMs)}`}
                              />
                            );
                          })}
                        </div>

                        <p className="text-[9px] text-gray-600 mt-2">Click for detailed results and graphs</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {selectedResult && (
        <DetailModal
          result={selectedResult}
          onClose={() => setSelectedResult(null)}
        />
      )}
    </div>
  );
}
