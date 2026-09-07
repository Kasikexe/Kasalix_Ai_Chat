import { useState, useEffect } from 'react';
import { ListChecks, Plus, X, Loader, Trash2, Check, Lightbulb, ClipboardList, Globe, Palette, Rocket, Wrench, Bot, Zap, Package, Hammer, Target, BarChart3, RefreshCw, Lock, Smartphone, type LucideIcon } from 'lucide-react';
import { api } from '../services/api';

interface PlannedFeature {
 id: string;
 title: string;
 description: string;
 status: 'done' | 'in-progress' | 'planned';
 icon: string;
 order: number;
 createdAt: number;
}

const STATUS_STYLES: Record<string, { label: string; color: string }> = {
 done: { label: 'Done', color: 'bg-emerald-900/30 text-[#4a9988] border-emerald-700/30' },
 'in-progress': { label: 'In Progress', color: 'bg-amber-900/30 text-[#b8966a] border-amber-700/30' },
 planned: { label: 'Planned', color: 'bg-gray-800 text-gray-500 border-gray-700/50' },
};

const FEATURE_ICONS: { id: string; Icon: LucideIcon }[] = [
 { id: 'clipboard', Icon: ClipboardList },
 { id: 'globe', Icon: Globe },
 { id: 'palette', Icon: Palette },
 { id: 'rocket', Icon: Rocket },
 { id: 'bulb', Icon: Lightbulb },
 { id: 'wrench', Icon: Wrench },
 { id: 'bot', Icon: Bot },
 { id: 'zap', Icon: Zap },
 { id: 'package', Icon: Package },
 { id: 'hammer', Icon: Hammer },
 { id: 'target', Icon: Target },
 { id: 'chart', Icon: BarChart3 },
 { id: 'refresh', Icon: RefreshCw },
 { id: 'lock', Icon: Lock },
 { id: 'phone', Icon: Smartphone },
];

export function PlannedView({ isAdmin = false }: { isAdmin?: boolean }) {
 const [features, setFeatures] = useState<PlannedFeature[]>([]);
 const [loading, setLoading] = useState(true);
 const [showForm, setShowForm] = useState(false);
 const [formTitle, setFormTitle] = useState('');
 const [formDescription, setFormDescription] = useState('');
 const [formStatus, setFormStatus] = useState<'done' | 'in-progress' | 'planned'>('planned');
 const [formIcon, setFormIcon] = useState('clipboard');
 const [submitting, setSubmitting] = useState(false);
 const [editingId, setEditingId] = useState<string | null>(null);

 const fetchFeatures = async () => {
 setLoading(true);
 try {
 const data = await api.getPlannedFeatures();
 setFeatures(data.features || []);
 } catch {
 setFeatures([]);
 }
 setLoading(false);
 };

 useEffect(() => {
 fetchFeatures();
 }, []);

 const resetForm = () => {
 setFormTitle('');
 setFormDescription('');
 setFormStatus('planned');
 setFormIcon('clipboard');
 setEditingId(null);
 setShowForm(false);
 };

 const handleSubmit = async () => {
 if (!formTitle.trim() || !formDescription.trim()) return;
 setSubmitting(true);
 try {
 if (editingId) {
 await api.updatePlannedFeature(editingId, {
 title: formTitle.trim(),
 description: formDescription.trim(),
 status: formStatus,
 icon: formIcon,
 });
 } else {
 await api.addPlannedFeature({
 title: formTitle.trim(),
 description: formDescription.trim(),
 status: formStatus,
 icon: formIcon,
 });
 }
 resetForm();
 await fetchFeatures();
 } catch {}
 setSubmitting(false);
 };

 const handleEdit = (feature: PlannedFeature) => {
 setEditingId(feature.id);
 setFormTitle(feature.title);
 setFormDescription(feature.description);
 setFormStatus(feature.status);
 setFormIcon(FEATURE_ICONS.some((f) => f.id === feature.icon) ? feature.icon : 'clipboard');
 setShowForm(true);
 };

 const handleDelete = async (id: string) => {
 try {
 await api.deletePlannedFeature(id);
 await fetchFeatures();
 } catch {}
 };

 const handleStatusChange = async (feature: PlannedFeature, newStatus: 'done' | 'in-progress' | 'planned') => {
 try {
 await api.updatePlannedFeature(feature.id, { status: newStatus });
 await fetchFeatures();
 } catch {}
 };

 return (
 <div className="flex-1 flex flex-col overflow-hidden">
 {/* Header */}
 <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900/50">
 <div className="flex items-center gap-2">
 <ListChecks size={16} className="text-[#b8966a]"/>
 <h2 className="text-sm font-medium text-gray-200">Planned Features</h2>
 </div>
 {isAdmin && (
 <button
 onClick={() => { if (showForm) resetForm(); else setShowForm(true); }}
 className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
 showForm
 ? 'bg-red-900/30 text-[#c44] border border-red-700/30'
 : 'bg-amber-900/30 text-[#d4b68a] border border-amber-700/30 hover:bg-amber-800/40'
 }`}
 >
 {showForm ? <X size={14} /> : <Plus size={14} />}
 {showForm ? 'Cancel' : 'Add Feature'}
 </button>
 )}
 </div>

 {/* Add/Edit form (admin only) */}
 {showForm && isAdmin && (
 <div className="border-b border-gray-800 bg-gray-900/80 p-4">
 <div className="space-y-3 max-w-lg">
 <div>
 <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Title</label>
 <input
 type="text"
 value={formTitle}
 onChange={(e) => setFormTitle(e.target.value)}
 placeholder="Feature name"
 className="w-full mt-1 bg-gray-800 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-amber-700 transition-colors"
 />
 </div>
 <div>
 <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Description</label>
 <textarea
 value={formDescription}
 onChange={(e) => setFormDescription(e.target.value)}
 placeholder="Describe the feature..."
 rows={3}
 className="w-full mt-1 bg-gray-800 text-sm text-gray-200 placeholder-gray-600 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-amber-700 transition-colors resize-none"
 />
 </div>
 <div className="flex gap-3">
 <div className="flex-1">
 <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Status</label>
 <select
 value={formStatus}
 onChange={(e) => setFormStatus(e.target.value as any)}
 className="w-full mt-1 bg-gray-800 text-sm text-gray-200 rounded-lg px-3 py-2 border border-gray-700 outline-none focus:border-amber-700 transition-colors"
 >
 <option value="planned">Planned</option>
 <option value="in-progress">In Progress</option>
 <option value="done">Done</option>
 </select>
 </div>
 <div>
 <label className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">Icon</label>
 <div className="mt-1 flex flex-wrap gap-1 w-44">
 {FEATURE_ICONS.map(({ id: optId, Icon: OptIcon }) => (
 <button
 type="button"
 key={optId}
 onClick={() => setFormIcon(optId)}
 className={`w-7 h-7 flex items-center justify-center rounded-lg text-sm transition-all ${
 formIcon === optId
 ? 'bg-amber-600/30 border border-[#b8966a] scale-110'
 : 'bg-gray-800 border border-gray-700 hover:bg-gray-700'
 }`}
 title={optId}
 >
 <OptIcon size={14} className="mx-auto" />
 </button>
 ))}
 </div>
 </div>
 </div>
 <button
 onClick={handleSubmit}
 disabled={submitting || !formTitle.trim() || !formDescription.trim()}
 className="flex items-center gap-1.5 px-4 py-2 bg-[#5a4a30] hover:bg-[#6a5a40] text-white text-xs font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
 >
 {submitting ? <Loader size={14} className="animate-spin"/> : <Check size={14} />}
 {submitting ? 'Saving...' : editingId ? 'Update Feature' : 'Add Feature'}
 </button>
 </div>
 </div>
 )}

 {/* Features list */}
 <div className="flex-1 overflow-y-auto p-4">
 {loading ? (
 <div className="flex items-center justify-center py-20">
 <Loader size={20} className="animate-spin text-gray-500"/>
 </div>
 ) : features.length === 0 ? (
 <div className="flex flex-col items-center justify-center py-20 text-center px-4">
 <ListChecks size={40} className="text-gray-700 mb-3"/>
 <p className="text-sm text-gray-500">No planned features yet</p>
 {isAdmin && (
 <p className="text-xs text-gray-600 mt-1">Click"Add Feature"above to create the first one</p>
 )}
 </div>
 ) : (
 <div className="max-w-2xl mx-auto space-y-2">
 {features.map((feature) => {
 const statusStyle = STATUS_STYLES[feature.status] || STATUS_STYLES.planned;
 return (
 <div
 key={feature.id}
 className="group flex items-start gap-3 p-3 rounded-xl bg-gray-900/50 border border-gray-800 hover:border-gray-700 transition-all"
 >
 {/* Icon */}
 <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-lg flex-shrink-0 ${
 feature.status === 'done' ? 'bg-emerald-900/20' :
 feature.status === 'in-progress' ? 'bg-[#1a1610]' :
 'bg-gray-800'
 }`}>
 {(() => { const fi = FEATURE_ICONS.find((f) => f.id === feature.icon); const IconCmp = fi ? fi.Icon : ListChecks; return <IconCmp size={18} className="mx-auto" />; })()}
 </div>

 {/* Content */}
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 flex-wrap">
 <h3 className="text-sm font-medium text-gray-200">{feature.title || 'Untitled'}</h3>
 <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border ${statusStyle.color}`}>
 {statusStyle.label}
 </span>
 </div>
 <p className="text-xs text-gray-500 mt-1 leading-relaxed">{feature.description || 'No description'}</p>

 {/* Quick status toggle (admin only) */}
 {isAdmin && (
 <div className="flex items-center gap-1.5 mt-2">
 {(['planned', 'in-progress', 'done'] as const).map((s) => (
 <button
 type="button"
 key={s}
 onClick={() => handleStatusChange(feature, s)}
 className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium transition-all ${
 feature.status === s
 ? (STATUS_STYLES[s]?.color || 'bg-gray-800 text-gray-500')
 : 'text-gray-600 hover:text-gray-400 hover:bg-gray-800'
 }`}
 >
 {STATUS_STYLES[s]?.label || s}
 </button>
 ))}
 </div>
 )}
 </div>

 {/* Admin actions */}
 {isAdmin && (
 <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0">
 <button
 type="button"
 onClick={() => handleEdit(feature)}
 className="p-1 rounded text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors"
 title="Edit"
 >
 <svg width="12"height="12"viewBox="0 0 24 24"fill="none"stroke="currentColor"strokeWidth="2"strokeLinecap="round"strokeLinejoin="round">
 <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
 <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
 </svg>
 </button>
 <button
 type="button"
 onClick={() => handleDelete(feature.id)}
 className="p-1 rounded text-gray-600 hover:text-[#c44] hover:bg-red-900/20 transition-colors"
 title="Delete"
 >
 <Trash2 size={12} />
 </button>
 </div>
 )}
 </div>
 );
 })}

 {/* Idea hint at the bottom */}
 <div className="mt-6 p-4 rounded-xl bg-[#1a1610] border border-[#5a4a30]">
 <div className="flex items-start gap-3">
 <Lightbulb size={18} className="text-[#b8966a] flex-shrink-0 mt-0.5"/>
 <div>
 <p className="text-sm text-amber-200 font-medium">Have an idea?</p>
 <p className="text-xs text-[#d4b68a]/60 mt-1 leading-relaxed">
 {isAdmin
 ? 'Click"Add Feature"above to add new planned features.'
 : 'Suggest new features to the admin — they can add them here!'}
 </p>
 </div>
 </div>
 </div>
 </div>
 )}
 </div>
 </div>
 );
}
