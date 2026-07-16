import React, { useState, useContext } from 'react';
import { AuthContext } from '../context/AuthContext';
import { Panel } from '../components/Panel';
import { Button } from '../components/Button';
import { motion } from 'framer-motion';

export const Login = () => {
    const { login, register } = useContext(AuthContext);
    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        try {
            if (isLogin) {
                await login(username, password);
            } else {
                await register(username, email, password);
            }
            window.location.href = '/';
        } catch (err) {
            console.error(err);
            if (isLogin) {
                setError('Invalid credentials');
            } else {
                setError(err.response?.data?.username?.[0] || 'Registration failed. Try another username.');
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-gray-900 to-black opacity-50" />
            
            <div className="z-10 w-full max-w-md">
                <motion.h1 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-5xl font-black italic text-center mb-6 text-[var(--color-levelup-yellow)] drop-shadow-[2px_2px_0_var(--color-levelup-red)] tracking-tighter"
                >
                    EXECUTE OS v1.0
                </motion.h1>

                <Panel className={isLogin ? "bg-[var(--color-levelup-red)]" : "bg-indigo-950 border-[var(--color-levelup-yellow)]"}>
                    <form onSubmit={handleSubmit} className="space-y-6 flex flex-col">
                        <div className="flex justify-between items-center pb-2 border-b border-white/20">
                            <h2 className="text-3xl font-black text-white uppercase tracking-wider">
                                {isLogin ? 'Login' : 'Register'}
                            </h2>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsLogin(!isLogin);
                                    setError('');
                                }}
                                className="text-xs font-bold text-[var(--color-levelup-yellow)] uppercase border border-[var(--color-levelup-yellow)] px-2.5 py-1 hover:bg-white hover:text-black hover:border-white transition-all rounded select-none cursor-pointer"
                            >
                                {isLogin ? 'New operator?' : 'Have account?'}
                            </button>
                        </div>
                        
                        {error && <div className="bg-black text-white p-2 text-center font-bold text-xs border border-red-500 uppercase">{error}</div>}

                        <div className="space-y-4">
                            <div className="flex flex-col space-y-1">
                                <label className="text-[10px] font-black uppercase text-white/80">Username</label>
                                <input 
                                    type="text" 
                                    placeholder="Enter username" 
                                    className="p-3.5 bg-white text-black font-bold text-md outline-none border-4 border-black focus:border-[var(--color-levelup-yellow)] transition-colors"
                                    value={username}
                                    onChange={(e) => setUsername(e.target.value)}
                                    required
                                />
                            </div>

                            {!isLogin && (
                                <div className="flex flex-col space-y-1">
                                    <label className="text-[10px] font-black uppercase text-white/80">Email (Optional)</label>
                                    <input 
                                        type="email" 
                                        placeholder="operator@domain.com" 
                                        className="p-3.5 bg-white text-black font-bold text-md outline-none border-4 border-black focus:border-[var(--color-levelup-yellow)] transition-colors"
                                        value={email}
                                        onChange={(e) => setEmail(e.target.value)}
                                    />
                                </div>
                            )}

                            <div className="flex flex-col space-y-1">
                                <label className="text-[10px] font-black uppercase text-white/80">Password</label>
                                <input 
                                    type="password" 
                                    placeholder="••••••••" 
                                    className="p-3.5 bg-white text-black font-bold text-md outline-none border-4 border-black focus:border-[var(--color-levelup-yellow)] transition-colors"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                />
                            </div>
                        </div>
                        
                        <Button type="submit" variant="primary" className="mt-2" disabled={isLoading}>
                            {isLoading ? 'Processing...' : isLogin ? 'Engage' : 'Initialize Account'}
                        </Button>
                    </form>
                </Panel>
            </div>
        </div>
    );
};
