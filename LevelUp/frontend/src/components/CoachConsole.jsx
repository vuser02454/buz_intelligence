import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import api from '../utils/api';

export const CoachConsole = ({ checkin, onReset }) => {
    const { coach_score, coach_response, date } = checkin;
    const [reflectionAnswer, setReflectionAnswer] = useState(checkin.reflection_answer || '');
    const [savedAnswer, setSavedAnswer] = useState(checkin.reflection_answer || '');

    useEffect(() => {
        setReflectionAnswer(checkin.reflection_answer || '');
        setSavedAnswer(checkin.reflection_answer || '');
    }, [checkin]);

    // Map score levels to custom CSS theme styling
    const scoreThemes = {
        Bronze: {
            bg: 'bg-amber-900/30 border-amber-800 text-amber-500',
            glow: 'shadow-[0_0_15px_rgba(146,64,14,0.4)]',
            text: 'text-amber-500',
            badge: '🥉 BRONZE'
        },
        Silver: {
            bg: 'bg-slate-800/40 border-slate-700 text-slate-300',
            glow: 'shadow-[0_0_15px_rgba(148,163,184,0.4)]',
            text: 'text-slate-300',
            badge: '🥈 SILVER'
        },
        Gold: {
            bg: 'bg-yellow-950/30 border-yellow-800 text-yellow-500',
            glow: 'shadow-[0_0_20px_rgba(234,179,8,0.5)]',
            text: 'text-yellow-500',
            badge: '🥇 GOLD'
        },
        Diamond: {
            bg: 'bg-cyan-950/30 border-cyan-800 text-cyan-400',
            glow: 'shadow-[0_0_25px_rgba(34,211,238,0.6)]',
            text: 'text-cyan-400',
            badge: '💎 DIAMOND'
        }
    };

    const theme = scoreThemes[coach_score] || scoreThemes.Bronze;

    // Helper to parse the response text into sections
    const parseCoachResponse = (text) => {
        if (!text) return [];
        
        // Split by standard section indicators
        const sectionTitles = [
            'Daily Score',
            'Mission Review',
            'Pattern Detection',
            'Challenge My Thinking',
            'ONE Improvement',
            'Tomorrow',
            'Reflection Question'
        ];

        // Create a regex to match sections like "1. Daily Score", "2. Mission Review" or simply "Mission Review"
        const regexStr = sectionTitles.map(t => `(?:\\d+\\.\\s*)?${t}`).join('|');
        const regex = new RegExp(`(${regexStr})`, 'i');
        const parts = text.split(regex);
        
        const sections = [];
        let currentTitle = 'Summary';
        
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            if (!part) continue;
            
            // Check if this part matches one of our section titles
            const matchedTitle = sectionTitles.find(t => 
                part.toLowerCase().replace(/[^a-z]/g, '') === t.toLowerCase().replace(/[^a-z]/g, '')
            );
            
            if (matchedTitle) {
                currentTitle = matchedTitle;
            } else {
                sections.push({ title: currentTitle, content: part });
            }
        }
        return sections;
    };

    const sections = parseCoachResponse(coach_response);

    const handleSaveReflection = async (e) => {
        e.preventDefault();
        try {
            await api.patch(`checkins/${checkin.id}/`, { reflection_answer: reflectionAnswer });
            setSavedAnswer(reflectionAnswer);
            alert("Reflection saved to database! 🧠");
        } catch (err) {
            console.error("Failed to save reflection to database", err);
            alert("Failed to save reflection. Please check connection.");
        }
    };

    // Find the Reflection Question content to show near the interactive text area
    const reflectionSection = sections.find(s => s.title === 'Reflection Question');

    return (
        <div className="w-full max-w-2xl bg-black border-4 border-black p-6 space-y-6 rounded-lg relative overflow-hidden">
            {/* Background Grid Accent */}
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#111_1px,transparent_1px),linear-gradient(to_bottom,#111_1px,transparent_1px)] bg-[size:1.5rem_1.5rem] opacity-20 pointer-events-none" />

            <div className="relative flex justify-between items-center pb-4 border-b border-gray-800 z-10">
                <div>
                    <h3 className="text-2xl font-black text-white italic uppercase tracking-wider">Coach Terminal</h3>
                    <p className="text-xs text-gray-500 font-bold">LOG REPORT: {date}</p>
                </div>
                <button
                    onClick={onReset}
                    className="text-[10px] sm:text-xs bg-[var(--color-levelup-yellow)] text-black border-2 border-black font-black px-3 py-1.5 hover:bg-white transition-all shadow-[2px_2px_0_#000] active:translate-y-0.5 active:translate-x-0.5 active:shadow-[0px_0px_0_#000] cursor-pointer uppercase tracking-wider skew-panel-light"
                >
                    NEW LOG
                </button>
            </div>

            {/* Glowing Badge */}
            <motion.div 
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className={`border-4 p-5 text-center rounded flex flex-col items-center justify-center ${theme.bg} ${theme.glow} transition-all duration-300 z-10 relative`}
            >
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">Execution Quality Rating</span>
                <h2 className="text-3xl font-black italic tracking-tighter mt-1">{theme.badge}</h2>
            </motion.div>

            {/* XP Awarded Badges */}
            <div className="grid grid-cols-5 gap-2 border-2 border-gray-905 bg-gray-950 p-3 rounded z-10 relative">
                {[
                    { name: 'Body', val: checkin.xp_body, color: 'text-red-500' },
                    { name: 'Knowledge', val: checkin.xp_knowledge, color: 'text-yellow-500' },
                    { name: 'Comm', val: checkin.xp_communication, color: 'text-indigo-400' },
                    { name: 'Discipline', val: checkin.xp_discipline, color: 'text-green-500' },
                    { name: 'Reflect', val: checkin.xp_reflection, color: 'text-cyan-400' }
                ].map((stat, i) => (
                    <div key={i} className="text-center">
                        <div className="text-[9px] sm:text-[10px] font-black uppercase text-gray-500 truncate">{stat.name}</div>
                        <div className={`text-md sm:text-lg font-black tracking-tight mt-0.5 ${stat.color}`}>+{stat.val} XP</div>
                    </div>
                ))}
            </div>

            {/* Coach Feedbacks Sections */}
            <div className="space-y-4 z-10 relative max-h-[30rem] overflow-y-auto pr-2 custom-scrollbar">
                {sections
                    .filter(s => s.title !== 'Daily Score' && s.title !== 'Reflection Question')
                    .map((sec, idx) => (
                        <div key={idx} className="border border-gray-900 bg-gray-950 p-4 rounded skew-panel-light">
                            <h4 className="text-sm font-black uppercase tracking-wider text-[var(--color-levelup-yellow)] mb-2">
                                // {sec.title}
                            </h4>
                            <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-line font-medium">
                                {sec.content.replace(/^[:\s\-*]+/, '')}
                            </div>
                        </div>
                    ))}
            </div>

            {/* Reflection question interactive section */}
            {reflectionSection && (
                <div className="bg-gray-900/60 border-2 border-dashed border-gray-800 p-5 rounded-lg space-y-4 z-10 relative">
                    <h4 className="text-xs font-black uppercase tracking-wider text-cyan-400 flex items-center gap-2">
                        <span>💬</span> DAILY REFLECTION ASSIGNMENT
                    </h4>
                    <p className="text-sm italic font-bold text-gray-200">
                        "{reflectionSection.content.replace(/^[:\s\-*]+/, '')}"
                    </p>
                    
                    {!savedAnswer ? (
                        <form onSubmit={handleSaveReflection} className="space-y-3">
                            <textarea
                                placeholder="Type your honest self-reflection here..."
                                rows="3"
                                className="w-full p-3 bg-black text-white text-sm border border-gray-700 rounded outline-none focus:border-cyan-400 transition-colors resize-none"
                                value={reflectionAnswer}
                                onChange={(e) => setReflectionAnswer(e.target.value)}
                                required
                            />
                            <button
                                type="submit"
                                className="w-full py-2 bg-cyan-950 text-cyan-400 border border-cyan-800 font-bold uppercase text-xs tracking-wider rounded hover:bg-cyan-400 hover:text-black transition-colors"
                            >
                                Submit Reflection
                            </button>
                        </form>
                    ) : (
                        <div className="bg-black/50 p-3 border border-gray-800 rounded">
                            <span className="text-[10px] font-bold text-gray-500 uppercase">Your Entry:</span>
                            <p className="text-sm text-gray-300 italic">"{savedAnswer}"</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
