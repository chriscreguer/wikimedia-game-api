// src/scripts/cleanupDistributions.ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import DailyChallenge, { DailyChallengeDoc } from '../models/DailyChallenge'; // Adjust path, import Doc type
// Import necessary types for the copied function
import { ProcessedDistribution, ProcessedDistributionPoint, ScoreDistribution } from '../types/types';


dotenv.config(); // Load .env variables

// --- Configuration ---
const CHALLENGE_ID_TO_CLEAN = "67d8f5cba282513ea3e8cedc"; // The _id of the specific challenge document
const SCORE_THRESHOLD = 5000;
// --- End Configuration ---

// --- COPIED processDistributionData function ---
// We need this function here to recalculate the processed distribution
// Ideally, this would be in a shared utility file, but copying works for a script.
// Ensure this function definition is identical to the one in src/routes/images.ts
// (Including the fix to return density and the conditional percentileRank)
function processDistributionData(
    distributions: Array<{ score: number; count: number }>,
    userScore?: number, // userScore is not relevant for recalculation, pass undefined
    step: number = 25
): ProcessedDistribution {
    // Handle empty/null distributions
    if (!distributions) {
        return { percentileRank: undefined, curvePoints: [ { score: 0, density: 0, percentile: 0 }, { score: 5000, density: 0, percentile: 100 } ], totalParticipants: 0, minScore: 0, maxScore: 0, medianScore: 0 };
    }
    const totalParticipants = distributions.reduce((sum, item) => sum + (item.count || 0), 0);
    if (totalParticipants === 0) {
        return { percentileRank: undefined, curvePoints: [ { score: 0, density: 0, percentile: 0 }, { score: 5000, density: 0, percentile: 100 } ], totalParticipants: 0, minScore: 0, maxScore: 0, medianScore: 0 };
    }
    const allScores: number[] = [];
    distributions.forEach(dist => { const count = Math.max(0, Math.floor(dist.count || 0)); for (let i = 0; i < count; i++) { allScores.push(dist.score); } });
    const n = allScores.length;
    const bandwidth = 175; const minScoreDomain = 0; const maxScoreDomain = 5000;
    const gaussianKernel = (u: number): number => (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * u * u);
    const kdePointsRaw: Array<{ score: number, density: number }> = [];
    for (let x = minScoreDomain; x <= maxScoreDomain; x += step) { let densitySum = 0; for (const s of allScores) { const u = (x - s) / bandwidth; densitySum += gaussianKernel(u); } const density = (n > 0 && bandwidth > 0) ? densitySum / (n * bandwidth) : 0; kdePointsRaw.push({ score: x, density }); }
    let maxDensity = 0; kdePointsRaw.forEach(p => { if (p.density > maxDensity) maxDensity = p.density; });
    if (maxDensity > 0) { kdePointsRaw.forEach(p => { p.density /= maxDensity; }); }
    const finalCurvePointsCalculated: ProcessedDistributionPoint[] = [];
    let cumulativeCount = 0; let distIndex = 0;
    const sortedDistributions = [...distributions].sort((a, b) => a.score - b.score);
    for (const kdePoint of kdePointsRaw) { while (distIndex < sortedDistributions.length && sortedDistributions[distIndex].score <= kdePoint.score) { cumulativeCount += sortedDistributions[distIndex].count || 0; distIndex++; } const percentile = totalParticipants > 0 ? Math.round((cumulativeCount / totalParticipants) * 100) : 0; finalCurvePointsCalculated.push({ score: kdePoint.score, density: kdePoint.density, percentile }); }
    if (finalCurvePointsCalculated.length === 0) { finalCurvePointsCalculated.push({ score: 0, density: 0, percentile: 0 }); finalCurvePointsCalculated.push({ score: 5000, density: 0, percentile: 100 }); }
    const scoresFromDist = allScores; scoresFromDist.sort((a, b) => a - b);
    const minScore = scoresFromDist[0] ?? 0; const maxScore = scoresFromDist[scoresFromDist.length - 1] ?? 0;
    let medianScore: number; const mid = Math.floor(n / 2); if (n === 0) { medianScore = 0; } else if (n % 2 === 0) { medianScore = Math.round((scoresFromDist[mid - 1] + scoresFromDist[mid]) / 2); } else { medianScore = scoresFromDist[mid]; }
    let percentileRank: number | undefined = undefined; // No user score, so no rank needed here for recalculation
    // Explicitly map to ensure correct structure
    return { percentileRank, curvePoints: finalCurvePointsCalculated.map(p => ({ score: p.score, density: p.density, percentile: p.percentile })), totalParticipants, minScore, maxScore, medianScore };
}
// --- END COPIED function ---


async function cleanupAndRecalculateScores() {
  const connectionString = process.env.MONGODB_URI;
  if (!connectionString) {
  
    process.exit(1);
  }

  let connection;
  try {
    console.log("Connecting to MongoDB...");
    connection = await mongoose.connect(connectionString);
    console.log("MongoDB connected successfully.");

    // --- Step 1: Remove high scores ---
   
    const pullResult = await DailyChallenge.updateOne(
      { _id: CHALLENGE_ID_TO_CLEAN },
      { $pull: { 'stats.distributions': { score: { $gt: SCORE_THRESHOLD } } } }
    );
  

    if (pullResult.matchedCount === 0) {
    
      return; // Exit if document wasn't found
    }

    if (pullResult.modifiedCount === 0) {
    
       // We might still want to recalculate even if nothing was pulled, to ensure consistency
    } else {
      
    }

    // --- Step 2: Fetch the updated document ---
  
    const updatedChallenge = await DailyChallenge.findById(CHALLENGE_ID_TO_CLEAN);

    if (!updatedChallenge || !updatedChallenge.stats) {
  
      return; // Exit if document couldn't be fetched
    }

    const currentDistributions = updatedChallenge.stats.distributions || [];
   

    // --- Step 3: Recalculate Stats ---
  

    // Recalculate Completions
    const newCompletions = currentDistributions.reduce((sum, dist) => sum + (dist.count || 0), 0);
    

    // Recalculate Average Score
    const totalScoreSum = currentDistributions.reduce((sum, dist) => sum + (dist.score * (dist.count || 0)), 0);
    const newAverageScore = newCompletions > 0 ? (totalScoreSum / newCompletions) : 0;
  

    // Recalculate Processed Distribution
    // Pass undefined for userScore as it's not relevant here
    const newProcessedDistribution = processDistributionData(currentDistributions, undefined);
 


    // --- Step 4: Update the document with recalculated stats ---
  
    const updateStatsResult = await DailyChallenge.updateOne(
      { _id: CHALLENGE_ID_TO_CLEAN },
      {
        $set: {
          'stats.completions': newCompletions,
          'stats.averageScore': newAverageScore,
          'stats.processedDistribution': newProcessedDistribution
        }
      }
    );

 
    if (updateStatsResult.modifiedCount > 0) {
    
    } else {
   
    }

  } catch (error) {
   
  } finally {
    if (connection) {
       
        await mongoose.disconnect();
       
    }
  }
}

cleanupAndRecalculateScores();