import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export const StatsStar = ({ stats }) => {
    // Stat values (0 to 100)
    const data = [
        { name: 'Knowledge', value: stats?.knowledge || 10, maxLabel: 'Erudite' },
        { name: 'Body', value: stats?.guts || 10, maxLabel: 'Indomitable' },
        { name: 'Discipline', value: stats?.proficiency || 10, maxLabel: 'Zen Master' },
        { name: 'Reflection', value: stats?.kindness || 10, maxLabel: 'Self-Aware' },
        { name: 'Communication', value: stats?.charm || 10, maxLabel: 'Silver-Tongued' },
    ];

    const [leveledUpStat, setLeveledUpStat] = useState(null);
    const [isExpanding, setIsExpanding] = useState(false);

    // Hyper-reactive screen size detector to prevent labels from overflowing on mobile portraits
    const [dimensions, setDimensions] = useState({
        maxR: 120,
        labelOffset: 40
    });

    useEffect(() => {
        const handleResize = () => {
            const isSmall = window.innerWidth < 640;
            setDimensions({
                maxR: isSmall ? 80 : 120,
                labelOffset: isSmall ? 25 : 40
            });
        };
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    useEffect(() => {
        if (!stats) return;

        // Retrieve last saved levels from localStorage to detect level-up checkpoints (every 20 points)
        const lastLevelsStr = localStorage.getItem(`last_levels_${stats.id || 'default'}`);
        const currentLevels = {
            knowledge: Math.floor((stats.knowledge || 0) / 20),
            guts: Math.floor((stats.guts || 0) / 20),
            proficiency: Math.floor((stats.proficiency || 0) / 20),
            kindness: Math.floor((stats.kindness || 0) / 20),
            charm: Math.floor((stats.charm || 0) / 20),
        };

        if (lastLevelsStr) {
            const lastLevels = JSON.parse(lastLevelsStr);
            const keys = ['knowledge', 'guts', 'proficiency', 'kindness', 'charm'];
            const namesMap = {
                knowledge: 'Knowledge',
                guts: 'Body',
                proficiency: 'Discipline',
                kindness: 'Reflection',
                charm: 'Communication'
            };

            for (const key of keys) {
                if (currentLevels[key] > (lastLevels[key] || 0)) {
                    setLeveledUpStat(namesMap[key]);
                    setIsExpanding(true);
                    
                    // Reset animation state after 3 seconds
                    setTimeout(() => {
                        setIsExpanding(false);
                        setLeveledUpStat(null);
                    }, 3000);
                    break;
                }
            }
        }

        // Save current checkpoints
        localStorage.setItem(`last_levels_${stats.id || 'default'}`, JSON.stringify(currentLevels));
    }, [stats]);

    // Angles for the 5 points of the star (starting from top, clockwise)
    const angles = [-90, -18, 54, 126, 198];
    const innerAngles = [-54, 18, 90, 162, 234];

    // Helper to get coordinates
    const getCoord = (radius, angleDeg) => {
        const rad = (angleDeg * Math.PI) / 180;
        return {
            x: radius * Math.cos(rad),
            y: radius * Math.sin(rad)
        };
    };

    // Calculate paths for a 5-pointed star
    const generateStarPath = (values, maxRadius) => {
        let points = [];
        for (let i = 0; i < 5; i++) {
            // Outer point
            const rOuter = (values[i] / 100) * maxRadius;
            const pOuter = getCoord(rOuter, angles[i]);
            points.push(`${pOuter.x},${pOuter.y}`);

            // Inner point (midway between this outer point and the next)
            const nextIdx = (i + 1) % 5;
            const avgVal = (values[i] + values[nextIdx]) / 2;
            const rInner = ((avgVal / 100) * maxRadius) * 0.382;
            const pInner = getCoord(rInner, innerAngles[i]);
            points.push(`${pInner.x},${pInner.y}`);
        }
        return `M ${points.join(' L ')} Z`;
    };

    const maxR = dimensions.maxR;
    const labelOffset = dimensions.labelOffset;

    const backgroundPath = generateStarPath([100, 100, 100, 100, 100], maxR);
    const foregroundPath = generateStarPath(data.map(d => d.value), maxR);

    return (
        <div className="relative w-full h-96 flex items-center justify-center">
            {/* SVG Star Shape */}
            <svg viewBox="-160 -160 320 320" className="w-full h-full overflow-visible drop-shadow-[0_0_15px_rgba(0,0,0,0.5)]">
                <defs>
                    <linearGradient id="starGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#ffde00" />
                        <stop offset="100%" stopColor="#d97706" />
                    </linearGradient>
                </defs>

                {/* Background Dark Star */}
                <path d={backgroundPath} fill="#2a2a2a" stroke="#111" strokeWidth="2" />

                {/* Foreground Yellow Star */}
                <motion.path 
                    d={foregroundPath} 
                    fill="url(#starGrad)" 
                    stroke="#ffde00" 
                    strokeWidth="2"
                    initial={{ scale: 0, rotate: -30 }}
                    animate={isExpanding ? { 
                        scale: [1, 1.25, 1.15, 1.2, 1],
                        rotate: [0, 5, -5, 3, 0],
                        filter: [
                            "drop-shadow(0 0 0px rgba(255,222,0,0))",
                            "drop-shadow(0 0 25px rgba(255,222,0,0.95))",
                            "drop-shadow(0 0 15px rgba(255,222,0,0.75))",
                            "drop-shadow(0 0 20px rgba(255,222,0,0.85))",
                            "drop-shadow(0 0 0px rgba(255,222,0,0))"
                        ]
                    } : { scale: 1, rotate: 0 }}
                    transition={isExpanding ? { 
                        duration: 2.5, 
                        ease: "easeInOut" 
                    } : { type: 'spring', stiffness: 100, damping: 15 }}
                />

                {/* Grid Lines radiating from center to points */}
                {angles.map((angle, i) => {
                    const outer = getCoord(maxR, angle);
                    return (
                        <line 
                            key={`grid-${i}`}
                            x1="0" y1="0" x2={outer.x} y2={outer.y}
                            stroke="#555" strokeWidth="1" strokeDasharray="3 3"
                        />
                    );
                })}
            </svg>

            {/* Absolute Positioned Labels */}
            {data.map((stat, i) => {
                const pos = getCoord(maxR + labelOffset, angles[i]);
                const rotateClasses = ['-rotate-3', 'rotate-2', '-rotate-1', 'rotate-3', '-rotate-2'];
                
                return (
                    <div 
                        key={stat.name} 
                        className="absolute flex flex-col items-center justify-center pointer-events-none"
                        style={{
                            left: `calc(50% + ${pos.x}px)`,
                            top: `calc(50% + ${pos.y}px)`,
                            transform: 'translate(-50%, -50%)',
                        }}
                    >
                        <div className="flex items-center">
                            <div className={`bg-[var(--color-levelup-yellow)] text-black font-black text-[10px] sm:text-xs md:text-sm px-1.5 py-0.5 border-2 border-black tracking-tighter ${rotateClasses[i]}`}>
                                {stat.name}
                            </div>
                            {stat.value >= 100 && (
                                <div className={`bg-black text-[var(--color-levelup-yellow)] font-black text-[8px] sm:text-xs px-1 py-0.5 border-2 border-[var(--color-levelup-yellow)] -ml-1 mt-2 z-10 ${rotateClasses[(i+2)%5]}`}>
                                    MAX
                                </div>
                            )}
                        </div>
                        <div className="text-white font-bold text-[10px] sm:text-xs mt-1 drop-shadow-md">
                            {stat.value >= 100 ? stat.maxLabel : `Lv ${Math.floor(stat.value / 20) + 1}`}
                        </div>
                    </div>
                );
            })}

            {/* Holographic Checkpoint Leveled Up Banner Overlay */}
            <AnimatePresence>
                {isExpanding && (
                    <motion.div
                        initial={{ opacity: 0, y: 30, scale: 0.8, rotate: -15 }}
                        animate={{ opacity: 1, y: 0, scale: 1, rotate: -3 }}
                        exit={{ opacity: 0, y: -40, scale: 0.8, rotate: 15 }}
                        transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                        className="absolute z-30 pointer-events-none flex flex-col items-center justify-center bg-black border-4 border-[var(--color-levelup-yellow)] px-6 py-3 shadow-[0_0_30px_rgba(255,222,0,0.6)]"
                    >
                        <span className="text-red-500 font-black text-xs uppercase tracking-widest animate-pulse">CHECKPOINT CLEAR!</span>
                        <h3 className="text-xl sm:text-2xl font-black text-[var(--color-levelup-yellow)] uppercase italic tracking-tighter mt-0.5">
                            {leveledUpStat} Leveled Up!
                        </h3>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
