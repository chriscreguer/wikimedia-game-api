export interface ScoreDistribution {
    score: number;
    count: number;
}

export interface ProcessedDistributionPoint {
    score: number;
    density: number; // Use density, not count
    percentile: number;
}

export interface ProcessedDistribution {
    percentileRank?: number;
    curvePoints: ProcessedDistributionPoint[];
    totalParticipants: number;
    minScore: number;
    maxScore: number;
    medianScore: number;
}

export interface ChallengeStats {
    averageScore: number;
    completions: number;
    distributions: ScoreDistribution[]; // Raw counts
    processedDistribution?: ProcessedDistribution; // KDE results
} 