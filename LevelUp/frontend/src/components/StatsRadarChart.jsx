import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';

export const StatsRadarChart = ({ stats }) => {
    const data = [
        { subject: 'Knowledge', A: stats?.knowledge || 0, fullMark: 100 },
        { subject: 'Communication', A: stats?.charm || 0, fullMark: 100 },
        { subject: 'Body', A: stats?.guts || 0, fullMark: 100 },
        { subject: 'Reflection', A: stats?.kindness || 0, fullMark: 100 },
        { subject: 'Discipline', A: stats?.proficiency || 0, fullMark: 100 },
    ];

    return (
        <div className="w-full h-80 drop-shadow-xl">
            <ResponsiveContainer width="100%" height="100%">
                <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
                    <PolarGrid stroke="#666" />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: 'white', fontSize: 16, fontWeight: 'bold' }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar
                        name="Player Stats"
                        dataKey="A"
                        stroke="var(--color-levelup-yellow)"
                        strokeWidth={3}
                        fill="var(--color-levelup-red)"
                        fillOpacity={0.7}
                    />
                </RadarChart>
            </ResponsiveContainer>
        </div>
    );
};
