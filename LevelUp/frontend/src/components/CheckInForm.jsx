import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from './Button';

export const CheckInForm = ({ onSubmit, isSubmitting }) => {
    const [step, setStep] = useState(1);
    const [formData, setFormData] = useState({
        sleep: '',
        energy: 5,
        mood: 5,
        main_mission: localStorage.getItem('onboarding_mission') || '',
        definition_of_done: localStorage.getItem('onboarding_dod') || '',
        completed: false,
        wins: '',
        avoidance: '',
        distractions: '',
        daydreaming_occurred: false,
        daydreaming_trigger: '',
        daydreaming_duration: '',
        daydreaming_preceded_by: '',
        daydreaming_interrupted_by: '',
        xp_body: 0,
        xp_knowledge: 0,
        xp_communication: 0,
        xp_discipline: 0,
        xp_reflection: 0,
        starting_easy: '',
        starting_difficult: '',
        tomorrow_mission: '',
        tomorrow_action: '',
        reward: ''
    });

    const nextStep = () => setStep(s => Math.min(s + 1, 3));
    const prevStep = () => setStep(s => Math.max(s - 1, 1));

    const handleNextStep = () => {
        if (step === 1 && !formData.sleep.trim()) {
            alert("Please enter sleep details to proceed.");
            return;
        }
        if (step === 2 && (!formData.main_mission.trim() || !formData.definition_of_done.trim())) {
            alert("Please enter today's Main Mission and Definition of Done to proceed.");
            return;
        }
        nextStep();
    };

    const handleChange = (e) => {
        const { name, value, type, checked } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: type === 'checkbox' ? checked : value
        }));
    };

    const handleNumberChange = (name, val) => {
        setFormData(prev => ({ ...prev, [name]: parseInt(val) || 0 }));
    };

    const handleSelectCompleted = (val) => {
        setFormData(prev => ({ ...prev, completed: val }));
    };

    const handleTagClick = (field, tagValue) => {
        setFormData(prev => {
            const currentVal = prev[field] || '';
            // If the chip is "None" / "❌ None", just replace the field entirely
            if (tagValue.includes("None")) {
                return { ...prev, [field]: 'None' };
            }
            if (!currentVal.trim() || currentVal.toLowerCase() === 'none') {
                return { ...prev, [field]: tagValue };
            }
            if (currentVal.includes(tagValue)) {
                return prev;
            }
            return { ...prev, [field]: `${currentVal}, ${tagValue}` };
        });
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!formData.tomorrow_mission.trim() || !formData.tomorrow_action.trim() || !formData.reward.trim()) {
            alert("Please enter tomorrow's Main Mission, First Action, and Reward to commit your log.");
            return;
        }
        localStorage.removeItem('onboarding_mission');
        localStorage.removeItem('onboarding_dod');
        localStorage.removeItem('onboarding_action');
        onSubmit(formData);
    };

    // Clickable neon tag preset chip component
    const TagGroup = ({ field, tags }) => (
        <div className="flex flex-wrap gap-1.5 mt-2">
            {tags.map((tag, i) => (
                <button
                    key={i}
                    type="button"
                    onClick={() => handleTagClick(field, tag)}
                    className="text-[10px] sm:text-xs font-black uppercase tracking-wider bg-black border border-gray-800 text-gray-400 hover:text-[var(--color-levelup-yellow)] hover:border-[var(--color-levelup-yellow)] px-2.5 py-1 transition-all rounded duration-150 cursor-pointer select-none"
                >
                    {tag}
                </button>
            ))}
        </div>
    );

    const renderStepContent = () => {
        switch (step) {
            case 1:
                return (
                    <motion.div
                        key="step1"
                        initial={{ opacity: 0, x: 50 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -50 }}
                        className="space-y-6"
                    >
                        <h3 className="text-2xl font-black text-[var(--color-levelup-yellow)] italic uppercase">Step 1: Vitals & Distractions</h3>
                        
                        <div className="flex flex-col space-y-2">
                            <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Sleep Duration / Quality</label>
                            <input
                                type="text"
                                name="sleep"
                                placeholder="e.g. 7.5 hours"
                                className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                value={formData.sleep}
                                onChange={handleChange}
                                required
                            />
                            <TagGroup field="sleep" tags={['7 Hours', '8 Hours', 'Restless Sleep', 'Deep Sleep', 'Tired']} />
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="flex flex-col space-y-2">
                                <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Energy Level: <span className="text-[var(--color-levelup-yellow)]">{formData.energy}</span></label>
                                <input
                                    type="range"
                                    name="energy"
                                    min="1"
                                    max="10"
                                    className="w-full accent-[var(--color-levelup-yellow)]"
                                    value={formData.energy}
                                    onChange={(e) => handleNumberChange('energy', e.target.value)}
                                />
                                <div className="flex justify-between text-[10px] text-gray-500 font-bold">
                                    <span>EXHAUSTED</span>
                                    <span>PEAK</span>
                                </div>
                            </div>
                            <div className="flex flex-col space-y-2">
                                <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Mood Rating: <span className="text-[var(--color-levelup-yellow)]">{formData.mood}</span></label>
                                <input
                                    type="range"
                                    name="mood"
                                    min="1"
                                    max="10"
                                    className="w-full accent-[var(--color-levelup-yellow)]"
                                    value={formData.mood}
                                    onChange={(e) => handleNumberChange('mood', e.target.value)}
                                />
                                <div className="flex justify-between text-[10px] text-gray-500 font-bold">
                                    <span>AWFUL</span>
                                    <span>EXCELLENT</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col space-y-2 pt-2 border-t border-gray-800">
                            <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Distractions Encountered</label>
                            <input
                                type="text"
                                name="distractions"
                                placeholder="What took you offline?"
                                className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                value={formData.distractions}
                                onChange={handleChange}
                            />
                            <TagGroup field="distractions" tags={['🎥 YouTube', '🎮 Gaming', '📱 Instagram/TikTok', '🎧 Music', '❌ None']} />
                        </div>

                        <div className="flex flex-col space-y-3 pt-2 border-t border-gray-800">
                            <div className="flex items-center space-x-3 bg-gray-950 p-3 border border-gray-800 rounded">
                                <input
                                    type="checkbox"
                                    name="daydreaming_occurred"
                                    id="daydreaming_occurred"
                                    className="w-5 h-5 rounded border-gray-700 text-[var(--color-levelup-yellow)] focus:ring-0 cursor-pointer"
                                    checked={formData.daydreaming_occurred}
                                    onChange={handleChange}
                                />
                                <label htmlFor="daydreaming_occurred" className="text-xs sm:text-sm font-bold uppercase text-white cursor-pointer select-none">
                                    Did immersive daydreaming occur?
                                </label>
                            </div>

                            {formData.daydreaming_occurred && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    className="space-y-3 pt-1 border-l-4 border-[var(--color-levelup-yellow)] pl-4"
                                >
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="flex flex-col space-y-1">
                                            <label className="text-[10px] font-bold uppercase text-gray-400">Trigger</label>
                                            <input
                                                type="text"
                                                name="daydreaming_trigger"
                                                className="p-2 bg-black text-white border border-gray-700 rounded text-xs outline-none focus:border-[var(--color-levelup-yellow)]"
                                                value={formData.daydreaming_trigger}
                                                onChange={handleChange}
                                            />
                                            <TagGroup field="daydreaming_trigger" tags={['🥱 Boredom', '🎧 Music', '💻 Stuck on code', '❌ None']} />
                                        </div>
                                        <div className="flex flex-col space-y-1">
                                            <label className="text-[10px] font-bold uppercase text-gray-400">Duration (approx)</label>
                                            <input
                                                type="text"
                                                name="daydreaming_duration"
                                                placeholder="e.g. 15 minutes"
                                                className="p-2 bg-black text-white border border-gray-700 rounded text-xs outline-none focus:border-[var(--color-levelup-yellow)]"
                                                value={formData.daydreaming_duration}
                                                onChange={handleChange}
                                            />
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="flex flex-col space-y-1">
                                            <label className="text-[10px] font-bold uppercase text-gray-400">Immediately Before</label>
                                            <input
                                                type="text"
                                                name="daydreaming_preceded_by"
                                                placeholder="What were you doing?"
                                                className="p-2 bg-black text-white border border-gray-700 rounded text-xs outline-none focus:border-[var(--color-levelup-yellow)]"
                                                value={formData.daydreaming_preceded_by}
                                                onChange={handleChange}
                                            />
                                        </div>
                                        <div className="flex flex-col space-y-1">
                                            <label className="text-[10px] font-bold uppercase text-gray-400">What Interrupted It?</label>
                                            <input
                                                type="text"
                                                name="daydreaming_interrupted_by"
                                                placeholder="How did you snap out?"
                                                className="p-2 bg-black text-white border border-gray-700 rounded text-xs outline-none focus:border-[var(--color-levelup-yellow)]"
                                                value={formData.daydreaming_interrupted_by}
                                                onChange={handleChange}
                                            />
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </div>
                    </motion.div>
                );
            case 2:
                return (
                    <motion.div
                        key="step2"
                        initial={{ opacity: 0, x: 50 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -50 }}
                        className="space-y-6"
                    >
                        <h3 className="text-2xl font-black text-[var(--color-levelup-yellow)] italic uppercase">Step 2: Mission & Review</h3>
                        
                        <div className="flex flex-col space-y-2">
                            <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Today's Main Mission</label>
                            <input
                                type="text"
                                name="main_mission"
                                placeholder="e.g. Complete Lesson 6 and build one API endpoint."
                                className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                value={formData.main_mission}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="flex flex-col space-y-2">
                            <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Definition of Done (DOD)</label>
                            <input
                                type="text"
                                name="definition_of_done"
                                placeholder="Describe what constitutes 'complete' for this mission."
                                className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                value={formData.definition_of_done}
                                onChange={handleChange}
                                required
                            />
                        </div>

                        <div className="flex flex-col space-y-3 pt-2 border-t border-gray-800">
                            <label className="text-sm font-bold uppercase tracking-wider text-gray-300">Mission Completed?</label>
                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    type="button"
                                    onClick={() => handleSelectCompleted(true)}
                                    className={`py-2.5 font-black uppercase tracking-wider border-2 transition-all duration-200 skew-panel ${formData.completed ? 'bg-[var(--color-levelup-yellow)] text-black border-[var(--color-levelup-yellow)] shadow-[0_0_15px_rgba(255,222,0,0.3)]' : 'bg-transparent text-white border-gray-800 hover:border-gray-600'}`}
                                >
                                    <span className="unskew-content">YES (Success)</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleSelectCompleted(false)}
                                    className={`py-2.5 font-black uppercase tracking-wider border-2 transition-all duration-200 skew-panel ${!formData.completed ? 'bg-red-650 text-white border-red-650 shadow-[0_0_15px_rgba(239,68,68,0.3)]' : 'bg-transparent text-white border-gray-800 hover:border-gray-600'}`}
                                >
                                    <span className="unskew-content">NO (Failed)</span>
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-gray-800">
                            <div className="flex flex-col space-y-2">
                                <label className="text-xs font-bold uppercase text-gray-300">Today's Wins / Highlights</label>
                                <textarea
                                    name="wins"
                                    placeholder="What did you get done?"
                                    rows="2"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors resize-none text-sm"
                                    value={formData.wins}
                                    onChange={handleChange}
                                />
                                <TagGroup field="wins" tags={['💻 Completed Mission', '🚀 Started Early', '🔥 Highly Focused', '✅ Cleared Queue']} />
                            </div>
                            <div className="flex flex-col space-y-2">
                                <label className="text-xs font-bold uppercase text-gray-300">Today's Avoidance</label>
                                <textarea
                                    name="avoidance"
                                    placeholder="What did you avoid/procrastinate?"
                                    rows="2"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors resize-none text-sm"
                                    value={formData.avoidance}
                                    onChange={handleChange}
                                />
                                <TagGroup field="avoidance" tags={['💤 Felt Tired', '🤯 Task too big', '😒 Task was boring', '📱 Phone scroll trap']} />
                            </div>
                        </div>
                    </motion.div>
                );
            case 3:
                return (
                    <motion.div
                        key="step3"
                        initial={{ opacity: 0, x: 50 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -50 }}
                        className="space-y-6"
                    >
                        <h3 className="text-2xl font-black text-[var(--color-levelup-yellow)] italic uppercase">Step 3: Tomorrow's Plan</h3>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="flex flex-col space-y-2">
                                <label className="text-xs font-bold uppercase text-gray-300">What made starting easy?</label>
                                <textarea
                                    name="starting_easy"
                                    placeholder="Any friction reducers?"
                                    rows="2"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors resize-none text-sm"
                                    value={formData.starting_easy}
                                    onChange={handleChange}
                                />
                                <TagGroup field="starting_easy" tags={['📝 Action was clear', '⏳ Used Pomodoro', '🎧 Lo-fi beats', '💻 IDE open']} />
                            </div>
                            <div className="flex flex-col space-y-2">
                                <label className="text-xs font-bold uppercase text-gray-300">What made starting difficult?</label>
                                <textarea
                                    name="starting_difficult"
                                    placeholder="Any friction builders?"
                                    rows="2"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors resize-none text-sm"
                                    value={formData.starting_difficult}
                                    onChange={handleChange}
                                />
                                <TagGroup field="starting_difficult" tags={['🤯 Felt overwhelmed', '😒 Boring setup', '🥱 Poor energy', '⚠️ Distracted']} />
                            </div>
                        </div>

                        <div className="border-t border-gray-800 pt-4 space-y-4">
                            <h4 className="text-lg font-bold text-white uppercase tracking-wide">// Tomorrow's Setup</h4>
                            <div className="flex flex-col space-y-2">
                                <label className="text-xs font-bold uppercase text-gray-400">Tomorrow's Main Mission</label>
                                <input
                                    type="text"
                                    name="tomorrow_mission"
                                    placeholder="ONE main execution item"
                                    className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                    value={formData.tomorrow_mission}
                                    onChange={handleChange}
                                    required
                                />
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div className="flex flex-col space-y-2">
                                    <label className="text-xs font-bold uppercase text-gray-400">First Action (&lt; 2 minutes)</label>
                                    <input
                                        type="text"
                                        name="tomorrow_action"
                                        placeholder="e.g. Open IDE, set timer"
                                        className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                        value={formData.tomorrow_action}
                                        onChange={handleChange}
                                        required
                                    />
                                </div>
                                <div className="flex flex-col space-y-2">
                                    <label className="text-xs font-bold uppercase text-gray-400">Reward</label>
                                    <input
                                        type="text"
                                        name="reward"
                                        placeholder="Specific reward upon completion"
                                        className="p-3 bg-black text-white border-2 border-gray-700 rounded outline-none focus:border-[var(--color-levelup-yellow)] transition-colors"
                                        value={formData.reward}
                                        onChange={handleChange}
                                        required
                                    />
                                    <TagGroup field="reward" tags={['☕ Hot coffee', '🎮 30m gaming', '🍫 Chocolate', '🎬 Watch show', '❌ None']} />
                                </div>
                            </div>
                        </div>
                    </motion.div>
                );
            default:
                return null;
        }
    };

    return (
        <form onSubmit={handleSubmit} className="w-full max-w-2xl bg-gray-900 border-4 border-black p-4 sm:p-6 space-y-6 relative rounded-lg">
            {/* Step Progress Tracker */}
            <div className="flex items-center justify-between pb-4 border-b border-gray-800">
                <span className="text-xs font-black text-gray-400 uppercase tracking-widest">Execute OS Check-in</span>
                <div className="flex space-x-1 flex-1 max-w-[100px] justify-end">
                    {[1, 2, 3].map(s => (
                        <div
                            key={s}
                            className={`h-2 flex-1 max-w-[24px] transition-colors duration-200 ${s === step ? 'bg-[var(--color-levelup-yellow)]' : s < step ? 'bg-green-500' : 'bg-gray-800'}`}
                        />
                    ))}
                </div>
            </div>

            {/* Sliding Form Elements */}
            <div className="min-h-[22rem]">
                <AnimatePresence mode="wait">
                    {renderStepContent()}
                </AnimatePresence>
            </div>

            {/* Controls */}
            <div className="flex justify-between items-center pt-4 border-t border-gray-800">
                {step > 1 ? (
                    <Button type="button" onClick={prevStep}>
                        Previous
                    </Button>
                ) : (
                    <div />
                )}

                {step < 3 ? (
                    <Button type="button" onClick={handleNextStep} variant="primary">
                        Next Step
                    </Button>
                ) : (
                    <Button type="submit" variant="primary" disabled={isSubmitting}>
                        {isSubmitting ? 'Generating Coach Review...' : 'Commit Log & Score'}
                    </Button>
                )}
            </div>
        </form>
    );
};
