import React from 'react';
import { motion } from 'framer-motion';

export const Panel = ({ children, className = '', animate = true }) => {
    const baseClasses = "relative bg-white text-black p-6 border-4 border-black shadow-[8px_8px_0px_0px_rgba(255,222,0,1)]";
    const Content = (
        <div className={`${baseClasses} ${className} skew-panel overflow-hidden`}>
            <div className="unskew-content w-full h-full">
                {children}
            </div>
        </div>
    );

    if (animate) {
        return (
            <motion.div
                initial={{ opacity: 0, x: -50, y: 50, rotate: -5, scale: 0.9 }}
                animate={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 400, damping: 25, mass: 1.2 }}
                whileHover={{ scale: 1.02, rotate: 1 }}
            >
                {Content}
            </motion.div>
        );
    }
    
    return Content;
};
