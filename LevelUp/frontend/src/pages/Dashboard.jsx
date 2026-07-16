import React, { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Panel } from '../components/Panel';
import { StatsStar } from '../components/StatsStar';
import { Button } from '../components/Button';
import { CheckInForm } from '../components/CheckInForm';
import { CoachConsole } from '../components/CoachConsole';
import { motion, AnimatePresence } from 'framer-motion';
import api from '../utils/api';

export const Dashboard = () => {
    const { user, logout } = useContext(AuthContext);
    const [checkins, setCheckins] = useState([]);
    const [activeCheckin, setActiveCheckin] = useState(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [forceNewForm, setForceNewForm] = useState(false);
    const [weeklyReview, setWeeklyReview] = useState(null);
    const [isLoadingReview, setIsLoadingReview] = useState(false);
    const [showReviewModal, setShowReviewModal] = useState(false);
    const [modalTab, setModalTab] = useState('overview');
    const [weeklyReviewDeep, setWeeklyReviewDeep] = useState(null);
    const [isLoadingDeepReview, setIsLoadingDeepReview] = useState(false);
    
    // Onboarding calibration states
    const [showOnboarding, setShowOnboarding] = useState(false);
    const [onboardingForm, setOnboardingForm] = useState({
        mission: '',
        dod: '',
        action: ''
    });

    useEffect(() => {
        if (checkins.length === 0 && !localStorage.getItem('onboarding_completed') && user) {
            setShowOnboarding(true);
        } else {
            setShowOnboarding(false);
        }
    }, [checkins, user]);

    const getSectionText = (text, headerName, nextHeaderName) => {
        if (!text) return '';
        const startIdx = text.toLowerCase().indexOf(headerName.toLowerCase());
        if (startIdx === -1) return '';
        const contentStart = text.indexOf('\n', startIdx) + 1;
        if (nextHeaderName) {
            const endIdx = text.toLowerCase().indexOf(nextHeaderName.toLowerCase(), contentStart);
            if (endIdx !== -1) {
                return text.substring(contentStart, endIdx).trim();
            }
        }
        return text.substring(contentStart).trim();
    };

    const parseWeeklyReview = (text) => {
        if (!text) return null;
        const summary = getSectionText(text, '6. Execution Summary', '7. Core Directives');
        const directives = getSectionText(text, '7. Core Directives', null);
        const distractions = getSectionText(text, '1. Distraction Triggers', '2. Avoidance Patterns');
        const avoidance = getSectionText(text, '2. Avoidance Patterns', '3. Hyperfocus Events');
        const hyperfocus = getSectionText(text, '3. Hyperfocus Events', '4. Routines');
        
        if (!summary && !directives && !distractions) return null;
        return { summary, directives, distractions, avoidance, hyperfocus };
    };

    const renderBoldText = (text, defaultColor = "text-gray-300", highlightColor = "text-[var(--color-levelup-yellow)]") => {
        if (!text) return null;
        const parts = text.split('**');
        return parts.map((part, i) => {
            if (i % 2 === 1) {
                return <span key={i} className={`${highlightColor} font-black`}>{part}</span>;
            }
            return <span key={i} className={defaultColor}>{part}</span>;
        });
    };

    const renderMarkdownText = (text, defaultColor = "text-gray-300", highlightColor = "text-[var(--color-levelup-yellow)]") => {
        if (!text) return null;
        return text.split('\n').map((line, i) => {
            if (line.startsWith('###')) {
                return <h4 key={i} className={`text-sm font-black uppercase tracking-widest ${highlightColor} mt-4 mb-2`}>{line.replace(/###\s*/, '')}</h4>;
            }
            if (line.startsWith('- ') || line.startsWith('* ')) {
                return <p key={i} className={`ml-4 mb-1 flex`}><span className={`${highlightColor} mr-2`}>▶</span> {renderBoldText(line.substring(2), defaultColor, highlightColor)}</p>;
            }
            return <p key={i} className="mb-2">{renderBoldText(line, defaultColor, highlightColor)}</p>;
        });
    };

    const fetchDeepAnalysis = async () => {
        setIsLoadingDeepReview(true);
        try {
            const res = await api.get('weekly-review/?deep=true');
            setWeeklyReviewDeep(res.data.review);
        } catch (err) {
            console.error("Failed to generate deep review", err);
            setWeeklyReviewDeep("Coaching System Error: Failed to generate deep analysis.");
        } finally {
            setIsLoadingDeepReview(false);
        }
    };

    // Fetch previous checkins
    const fetchCheckins = async () => {
        try {
            const res = await api.get('checkins/');
            setCheckins(res.data);
        } catch (err) {
            console.error("Failed to fetch check-ins", err);
        }
    };

    useEffect(() => {
        fetchCheckins();
    }, []);

    // Determine if user has checked in today
    const getTodayCheckin = () => {
        if (!checkins || checkins.length === 0) return null;
        // Compare dates in local string format YYYY-MM-DD
        const localToday = new Date().toLocaleDateString('sv'); // 'sv' locale outputs YYYY-MM-DD
        return checkins.find(c => c.date === localToday);
    };

    const handleFormSubmit = async (formData) => {
        setIsSubmitting(true);
        try {
            const res = await api.post('checkins/', formData);
            setCheckins(prev => [res.data, ...prev]);
            setActiveCheckin(res.data);
            setForceNewForm(false);
            // Refresh auth user stats (xp, coins, level, stats)
            window.location.reload(); 
        } catch (err) {
            console.error("Failed to submit check-in", err);
            alert("Error submitting check-in. Is Gemini key configured?");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleGenerateWeeklyReview = async () => {
        setIsLoadingReview(true);
        setWeeklyReview(null);
        setWeeklyReviewDeep(null);
        setShowReviewModal(true);
        setModalTab('overview');
        try {
            const res = await api.get('checkins/weekly-review/');
            setWeeklyReview(res.data.review);
        } catch (err) {
            console.error("Failed to generate weekly review", err);
            setWeeklyReview("Error generating review. Make sure you have at least one check-in log within the past 7 days, and your GEMINI_API_KEY is configured in your backend .env file.");
        } finally {
            setIsLoadingReview(false);
        }
    };

    if (!user) return <div className="p-10 text-white font-bold text-2xl uppercase">Loading profile...</div>;

    const { profile } = user;
    const todayCheckin = getTodayCheckin();
    const displayCheckin = activeCheckin || todayCheckin;

    return (
        <div className="min-h-screen bg-black overflow-x-hidden p-4 sm:p-8">
            <div className="max-w-7xl mx-auto space-y-10">
                {/* Header Section */}
                <div className="flex flex-col md:flex-row justify-between items-center gap-4">
                    <motion.h1 
                        initial={{ x: -100, opacity: 0, rotate: -5 }}
                        animate={{ x: 0, opacity: 1, rotate: [-2, 2, -2] }}
                        transition={{ 
                            x: { type: 'spring', stiffness: 300, damping: 20 },
                            rotate: { repeat: Infinity, duration: 4, ease: "easeInOut" }
                        }}
                        className="text-4xl sm:text-6xl font-black italic tracking-tighter text-[var(--color-levelup-yellow)] drop-shadow-[4px_4px_0_var(--color-levelup-red)] hover:drop-shadow-[8px_8px_0_var(--color-levelup-red)] transition-all cursor-default text-center md:text-left"
                    >
                        EXECUTE OS v1.0
                    </motion.h1>
                    <div className="flex gap-4 items-center">
                        <Button variant="primary" onClick={handleGenerateWeeklyReview}>Weekly Analysis</Button>
                        <Button variant="danger" onClick={logout}>Logout</Button>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    {/* Left Column: Player Info & Timeline history */}
                    <div className="space-y-8 col-span-1">
                        <Panel className="bg-[var(--color-levelup-yellow)]">
                            <h2 className="text-3xl font-bold uppercase mb-4 text-black">Operator Profile</h2>
                            <div className="text-xl font-bold text-black space-y-2">
                                <p>Name: <span className="text-red-600">{user.username}</span></p>
                                <p>Rank: {profile.rank}</p>
                                <p>Level: {profile.level}</p>
                                <p>Execution Streak: <span className="text-red-600">{profile.current_streak} days</span></p>
                            </div>
                            <div className="mt-6">
                                <div className="text-sm font-bold text-black uppercase mb-1">XP Progress</div>
                                <div className="h-6 w-full bg-black skew-panel p-1">
                                    <motion.div 
                                        initial={{ width: 0 }}
                                        animate={{ width: `${(profile.xp % 100)}%` }}
                                        className="h-full bg-red-600 unskew-content"
                                    />
                                </div>
                            </div>
                        </Panel>

                        {/* History Timeline */}
                        <Panel className="bg-white text-black border-black">
                            <h2 className="text-2xl font-bold uppercase mb-4 text-black border-b-4 border-black pb-2">Mission Timeline</h2>
                            <div className="space-y-3 max-h-80 overflow-y-auto pr-2">
                                {checkins.map((c) => {
                                    const scoreColors = {
                                        Bronze: 'text-amber-800 border-amber-800 bg-amber-50',
                                        Silver: 'text-slate-600 border-slate-600 bg-slate-50',
                                        Gold: 'text-yellow-600 border-yellow-600 bg-yellow-50',
                                        Diamond: 'text-cyan-600 border-cyan-600 bg-cyan-50'
                                    };
                                    const scoreColor = scoreColors[c.coach_score] || 'text-gray-600 border-gray-600';
                                    return (
                                        <div 
                                            key={c.id} 
                                            onClick={() => {
                                                setActiveCheckin(c);
                                                setForceNewForm(false);
                                            }}
                                            className={`p-3 border-2 border-black rounded cursor-pointer transition-all hover:bg-black hover:text-white flex justify-between items-center ${(displayCheckin?.id === c.id && !forceNewForm) ? 'bg-black text-white' : 'bg-gray-50'}`}
                                        >
                                            <div>
                                                <h4 className="font-bold text-sm">{c.date}</h4>
                                                <p className="text-xs opacity-75 truncate max-w-[150px]">{c.main_mission}</p>
                                            </div>
                                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 border rounded ${scoreColor}`}>
                                                {c.coach_score}
                                            </span>
                                        </div>
                                    );
                                })}
                                {checkins.length === 0 && (
                                    <p className="text-sm font-bold text-gray-500 italic">No previous logs found. Log your first mission today!</p>
                                )}
                            </div>
                        </Panel>
                    </div>

                    {/* Middle Column: Interactive Form / Coach Console */}
                    <div className="lg:col-span-2 space-y-8 flex flex-col items-center">
                        <AnimatePresence mode="wait">
                            {(displayCheckin && !forceNewForm) ? (
                                <motion.div 
                                    key="console"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    className="w-full"
                                >
                                    <CoachConsole 
                                        checkin={displayCheckin} 
                                        onReset={() => {
                                            setActiveCheckin(null);
                                            setForceNewForm(true);
                                        }} 
                                    />
                                </motion.div>
                            ) : (
                                <motion.div 
                                    key="form"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    className="w-full"
                                >
                                    <CheckInForm 
                                        onSubmit={handleFormSubmit} 
                                        isSubmitting={isSubmitting} 
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* Radar Stats Chart */}
                        <div className="w-full">
                            <Panel className="bg-gray-900 border-[var(--color-levelup-yellow)] h-[28rem] flex items-center justify-center relative">
                                <h2 className="text-2xl font-bold uppercase text-white mb-2 text-center absolute top-4">// Core Executive Stats</h2>
                                <StatsStar stats={profile} />
                            </Panel>
                        </div>
                    </div>
                </div>
            </div>

            {/* Weekly Review Holographic Modal */}
            {showReviewModal && (
                <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 overflow-y-auto font-mono">
                    <div className="bg-gray-950 border-4 border-[var(--color-levelup-yellow)] w-full max-w-4xl p-4 sm:p-6 rounded-lg shadow-[0_0_30px_rgba(255,222,0,0.3)] space-y-6 relative">
                        <div className="flex justify-between items-center pb-4 border-b-2 border-gray-800 gap-4">
                            <h3 className="text-xl sm:text-3xl font-black italic text-[var(--color-levelup-yellow)] tracking-wider">Weekly Diagnostics</h3>
                            <button 
                                onClick={() => setShowReviewModal(false)}
                                className="text-2xl font-bold text-gray-500 hover:text-white"
                            >
                                ✕
                            </button>
                        </div>

                        {/* Tabs Selector */}
                        {!isLoadingReview && weeklyReview && (
                            <div className="flex border-b border-gray-900 bg-black/40">
                                <button
                                    type="button"
                                    onClick={() => setModalTab('overview')}
                                    className={`flex-1 py-2.5 text-xs sm:text-sm font-black uppercase tracking-wider border-b-2 transition-all ${modalTab === 'overview' ? 'border-[var(--color-levelup-yellow)] text-[var(--color-levelup-yellow)] bg-gray-900/10' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                >
                                    📊 Simple Summary
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setModalTab('deep')}
                                    className={`flex-1 py-2.5 text-xs sm:text-sm font-black uppercase tracking-wider border-b-2 transition-all ${modalTab === 'deep' ? 'border-[var(--color-levelup-yellow)] text-[var(--color-levelup-yellow)] bg-gray-900/10' : 'border-transparent text-gray-500 hover:text-gray-300'}`}
                                >
                                    🔍 Deep Analysis
                                </button>
                            </div>
                        )}
                        
                        <div className="text-white text-sm leading-relaxed font-medium overflow-y-auto max-h-[32rem] pr-2 custom-scrollbar">
                            {isLoadingReview ? (
                                <div className="flex flex-col items-center justify-center py-20 space-y-4">
                                    <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-[var(--color-levelup-yellow)]"></div>
                                    <p className="text-[var(--color-levelup-yellow)] font-bold uppercase tracking-widest text-xs">Assembling review logs & generating insights...</p>
                                </div>
                            ) : modalTab === 'deep' ? (
                                <div className="space-y-4 font-mono text-left pr-2">
                                    {!weeklyReviewDeep ? (
                                        <div className="flex flex-col items-center justify-center py-20 space-y-4">
                                            {isLoadingDeepReview ? (
                                                <>
                                                    <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-purple-500"></div>
                                                    <p className="text-purple-400 font-bold uppercase tracking-widest text-xs">Deep scanning behavioral logs...</p>
                                                </>
                                            ) : (
                                                <Button onClick={fetchDeepAnalysis} variant="primary" className="bg-purple-900/40 hover:bg-purple-900/80 border-purple-600 text-purple-300">
                                                    Generate Deep Behavioral Analysis
                                                </Button>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="text-gray-300 text-sm leading-relaxed whitespace-pre-line">
                                            {renderMarkdownText(weeklyReviewDeep, "text-gray-300", "text-purple-400")}
                                        </div>
                                    )}
                                </div>
                            ) : (() => {
                                const parsed = parseWeeklyReview(weeklyReview);
                                if (!parsed) {
                                    return (
                                        <div className="space-y-4 font-mono text-gray-350 text-left whitespace-pre-line leading-relaxed pr-2">
                                            {weeklyReview}
                                        </div>
                                    );
                                }
                                return (
                                    <div className="space-y-6 font-mono text-left pr-2">
                                        {/* Execution Verdict Card */}
                                        {parsed.summary && (
                                            <div className="bg-red-950/20 border-2 border-red-900 p-4 rounded shadow-[0_0_15px_rgba(239,68,68,0.15)] skew-panel-light">
                                                <h4 className="text-xs font-black uppercase tracking-widest text-red-500 mb-1.5">// Execution Verdict</h4>
                                                <p className="text-sm leading-relaxed font-bold line-clamp-2">
                                                    {renderBoldText(parsed.summary, "text-red-400", "text-red-200")}
                                                </p>
                                            </div>
                                        )}

                                        {/* Core Directives Box */}
                                        {parsed.directives && (
                                            <div className="bg-gray-950 border-2 border-[var(--color-levelup-yellow)] p-4 rounded shadow-[0_0_20px_rgba(255,222,0,0.15)]">
                                                <h4 className="text-sm font-black uppercase tracking-widest text-[var(--color-levelup-yellow)] mb-2">// Core Directives for Next Week</h4>
                                                <div className="text-sm leading-relaxed whitespace-pre-line font-medium">
                                                    {renderBoldText(parsed.directives, "text-gray-300", "text-[var(--color-levelup-yellow)]")}
                                                </div>
                                            </div>
                                        )}

                                        {/* Distractions & Avoidance split grid */}
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            {parsed.distractions && (
                                                <div className="bg-gray-900/60 border border-gray-800 p-4 rounded">
                                                    <h4 className="text-xs font-black uppercase tracking-widest text-yellow-500 mb-2">// Top Distractions</h4>
                                                    <p className="text-xs leading-relaxed font-bold line-clamp-2">
                                                        {renderBoldText(parsed.distractions, "text-yellow-400/90", "text-yellow-300")}
                                                    </p>
                                                </div>
                                            )}
                                            {parsed.avoidance && (
                                                <div className="bg-gray-900/60 border border-gray-800 p-4 rounded">
                                                    <h4 className="text-xs font-black uppercase tracking-widest text-cyan-400 mb-2">// Avoidance Patterns</h4>
                                                    <p className="text-xs leading-relaxed font-bold line-clamp-2">
                                                        {renderBoldText(parsed.avoidance, "text-cyan-400/90", "text-cyan-300")}
                                                    </p>
                                                </div>
                                            )}
                                        </div>

                                        {/* Focus Lock Box */}
                                        {parsed.hyperfocus && (
                                            <div className="bg-gray-900/60 border border-gray-800 p-4 rounded">
                                                <h4 className="text-xs font-black uppercase tracking-widest text-purple-400 mb-2">// Focus Locks</h4>
                                                <p className="text-xs leading-relaxed font-bold line-clamp-2">
                                                    {renderBoldText(parsed.hyperfocus, "text-purple-400/90", "text-purple-300")}
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })()}
                        </div>
                        
                        <div className="flex justify-end pt-4 border-t border-gray-900">
                            <Button variant="primary" onClick={() => setShowReviewModal(false)}>Close Diagnostics</Button>
                        </div>
                    </div>
                </div>
            )}
            {/* Onboarding Calibration Modal */}
            {showOnboarding && (
                <div className="fixed inset-0 bg-black/95 flex items-center justify-center p-4 z-50 overflow-y-auto font-mono">
                    <div className="bg-gray-950 border-4 border-[var(--color-levelup-yellow)] w-full max-w-lg p-6 rounded-lg shadow-[0_0_40px_rgba(255,222,0,0.4)] space-y-6 relative text-left">
                        <div className="border-b border-gray-800 pb-3">
                            <span className="text-red-500 font-black text-xs uppercase tracking-widest animate-pulse">SYSTEM CALIBRATION REQUIRED</span>
                            <h3 className="text-3xl font-black italic text-[var(--color-levelup-yellow)] mt-1 uppercase tracking-wider">ONBOARDING OPERATOR</h3>
                        </div>

                        <p className="text-xs text-gray-400 leading-relaxed font-medium">
                            Welcome, Operator. We've detected 0 previous system logs. To initialize your dashboard profile, calibrate your target objective for today.
                        </p>

                        <form onSubmit={(e) => {
                            e.preventDefault();
                            if (!onboardingForm.mission.trim() || !onboardingForm.dod.trim() || !onboardingForm.action.trim()) {
                                alert("Please fill in all objectives to calibrate system.");
                                return;
                            }
                            localStorage.setItem('onboarding_mission', onboardingForm.mission);
                            localStorage.setItem('onboarding_dod', onboardingForm.dod);
                            localStorage.setItem('onboarding_action', onboardingForm.action);
                            localStorage.setItem('onboarding_completed', 'true');
                            setShowOnboarding(false);
                            alert("CALIBRATION SUCCESSFUL! Objectives initialized. ⚡");
                            setForceNewForm(true);
                        }} className="space-y-4">
                            <div className="flex flex-col space-y-1">
                                <label className="text-[10px] font-black uppercase text-gray-400">1. Today's ONE Main Mission</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Complete section 3 of Python course"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors text-sm font-bold"
                                    value={onboardingForm.mission}
                                    onChange={(e) => setOnboardingForm(prev => ({ ...prev, mission: e.target.value }))}
                                    required
                                />
                            </div>

                            <div className="flex flex-col space-y-1">
                                <label className="text-[10px] font-black uppercase text-gray-400">2. Definition of Done (DOD)</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Code works and passes the test suite"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors text-sm font-bold"
                                    value={onboardingForm.dod}
                                    onChange={(e) => setOnboardingForm(prev => ({ ...prev, dod: e.target.value }))}
                                    required
                                />
                            </div>

                            <div className="flex flex-col space-y-1">
                                <label className="text-[10px] font-black uppercase text-gray-400">3. First Action (&lt; 2 Minutes)</label>
                                <input
                                    type="text"
                                    placeholder="e.g. Open test_script.py in editor"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors text-sm font-bold"
                                    value={onboardingForm.action}
                                    onChange={(e) => setOnboardingForm(prev => ({ ...prev, action: e.target.value }))}
                                    required
                                />
                            </div>

                            <div className="pt-2">
                                <Button type="submit" variant="primary" className="w-full text-center">
                                    Activate OS System Interface
                                </Button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};
