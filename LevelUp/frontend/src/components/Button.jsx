import React from 'react';
import { motion } from 'framer-motion';

export const Button = ({ children, onClick, type = "button", variant = "primary", className = "" }) => {
    const baseClasses = "relative font-bold text-xl uppercase tracking-wider py-3 px-8 skew-panel border-4 border-black transition-all duration-200 focus:outline-none";
    
    let variantClasses = "";
    if (variant === 'primary') {
        variantClasses = "bg-[var(--color-levelup-yellow)] text-black hover:bg-white hover:text-black hover:shadow-[4px_4px_0px_0px_#e60012]";
    } else if (variant === 'danger') {
        variantClasses = "bg-[var(--color-levelup-red)] text-white hover:bg-white hover:text-red-600 hover:shadow-[4px_4px_0px_0px_#000]";
    } else if (variant === 'outline') {
        variantClasses = "bg-transparent text-white border-white hover:bg-white hover:text-black";
    }

    return (
        <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            type={type}
            onClick={onClick}
            className={`${baseClasses} ${variantClasses} ${className}`}
        >
            <div className="unskew-content">
                {children}
            </div>
        </motion.button>
    );
};
