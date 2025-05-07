import RoundGuess from '../models/RoundGuess';
import DailyChallenge, { DailyChallengeDoc } from '../models/DailyChallenge';
import logger from './logger'; // Assuming logger is in the same directory or accessible
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';

const TARGET_TIMEZONE = 'America/New_York'; // As defined in images.ts

interface KdePoint {
  guessedYear: number;
  density: number;
}

interface RoundGuessDistributionItem {
  roundIndex: number;
  curvePoints: Array<{
    guessedYear: number;
    density: number;
  }>;
  totalGuesses: number;
  minGuess: number;
  maxGuess: number;
  medianGuess: number;
}

function generateYearKdeCurve(
  allGuessedYearsInRound: number[], // Array of ALL individual year guesses for the round
  domainMin: number,
  domainMax: number,
  bandwidth: number, // Controls smoothness (e.g., 3, 5, or 7 years)
  step: number      // Determines how many points on the curve (e.g., 1 for yearly points)
): KdePoint[] {
  const kdePointsRaw: KdePoint[] = [];

  for (let currentYearToEvaluate = domainMin; currentYearToEvaluate <= domainMax; currentYearToEvaluate += step) {
    let densityValue = 0;
    if (allGuessedYearsInRound.length > 0 && bandwidth > 0) { // Ensure valid inputs for kernel calculation
      for (const guessedYear of allGuessedYearsInRound) {
        const u = (currentYearToEvaluate - guessedYear) / bandwidth;
        const kernelValue = (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * u * u);
        densityValue += kernelValue;
      }
      densityValue /= (allGuessedYearsInRound.length * bandwidth); // Normalize for area
    }
    kdePointsRaw.push({ guessedYear: currentYearToEvaluate, density: densityValue });
  }

  // Normalize densities so the peak is 1.0 for better visualization
  const maxOverallDensity = Math.max(...kdePointsRaw.map(p => p.density), 0);

  if (maxOverallDensity > 0) {
    return kdePointsRaw.map(point => ({
      ...point,
      density: point.density / maxOverallDensity,
    }));
  }
  return kdePointsRaw; // Return as is if all densities are 0
}

export async function processAndStoreRoundGuessDistributions(challengeDateString: string): Promise<void> {
  logger.info(`[ProcessRoundGuesses] Starting processing for date: ${challengeDateString}`);

  try {
    // Convert challengeDateString to the correct UTC Date object for RoundGuess
    // RoundGuess.challengeDate is stored as the UTC start of the day.
    const challengeDateUtc = new Date(challengeDateString + 'T00:00:00.000Z');
    if (isNaN(challengeDateUtc.getTime())) {
      logger.error(`[ProcessRoundGuesses] Invalid date string provided: ${challengeDateString}`);
      return;
    }

    logger.info(`[ProcessRoundGuesses] Fetching RoundGuess documents for challengeDate (UTC): ${challengeDateUtc.toISOString()}`);
    const guesses = await RoundGuess.find({ challengeDate: challengeDateUtc });

    if (!guesses || guesses.length === 0) {
      logger.info(`[ProcessRoundGuesses] No round guesses found for date: ${challengeDateString}.`);
      return;
    }
    logger.info(`[ProcessRoundGuesses] Found ${guesses.length} total round guesses for date: ${challengeDateString}.`);

    const processedRoundDistributions: RoundGuessDistributionItem[] = [];

    for (let roundIdx = 0; roundIdx < 5; roundIdx++) {
      const roundGuesses = guesses.filter(g => g.roundIndex === roundIdx);

      if (roundGuesses.length === 0) {
        logger.info(`[ProcessRoundGuesses] No guesses for round ${roundIdx} on date ${challengeDateString}. Skipping.`);
        continue;
      }

      const totalGuessesInRound = roundGuesses.length;
      const frequencyMap: { [year: number]: number } = {};
      const guessedYearsInRound: number[] = [];

      roundGuesses.forEach(guess => {
        frequencyMap[guess.guessedYear] = (frequencyMap[guess.guessedYear] || 0) + 1;
        guessedYearsInRound.push(guess.guessedYear);
      });

      guessedYearsInRound.sort((a, b) => a - b);

      const minGuessedYear = guessedYearsInRound[0];
      const maxGuessedYear = guessedYearsInRound[guessedYearsInRound.length - 1];
      
      let medianGuessedYear: number;
      const mid = Math.floor(guessedYearsInRound.length / 2);
      if (guessedYearsInRound.length % 2 === 0) {
        medianGuessedYear = Math.round((guessedYearsInRound[mid - 1] + guessedYearsInRound[mid]) / 2);
      } else {
        medianGuessedYear = guessedYearsInRound[mid];
      }

      // Define KDE parameters
      const MIN_YEAR_DOMAIN = 1850;
      const MAX_YEAR_DOMAIN = new Date().getFullYear(); // e.g., 2025
      const KDE_BANDWIDTH_YEARS = 1; // << ADJUST THIS FOR SMOOTHNESS (e.g., 3, 5, 7, 10)
      const KDE_STEP_YEARS = 1;      // << ADJUST THIS FOR FEWER/MORE POINTS (e.g., 1, 2, 3)

      const curvePoints = generateYearKdeCurve(
          guessedYearsInRound,       // Pass the array of all individual guesses
          MIN_YEAR_DOMAIN,
          MAX_YEAR_DOMAIN,
          KDE_BANDWIDTH_YEARS,
          KDE_STEP_YEARS
      );

      processedRoundDistributions.push({
        roundIndex: roundIdx,
        curvePoints,
        totalGuesses: totalGuessesInRound,
        minGuess: minGuessedYear,
        maxGuess: maxGuessedYear,
        medianGuess: medianGuessedYear,
      });
      logger.info(`[ProcessRoundGuesses] Processed round ${roundIdx} for ${challengeDateString}: ${totalGuessesInRound} guesses.`);
    }

    if (processedRoundDistributions.length === 0) {
        logger.info(`[ProcessRoundGuesses] No rounds with guesses found for ${challengeDateString}. No update to DailyChallenge needed.`);
        return;
    }

    // Find the DailyChallenge document using UTC midnight consistently
    const startDateForDailyChallengeQuery = new Date(challengeDateString + 'T00:00:00.000Z');
    const endDateForDailyChallengeQuery = new Date(startDateForDailyChallengeQuery.getTime() + 24 * 60 * 60 * 1000);

    logger.info(`[ProcessRoundGuesses] Attempting to find DailyChallenge for date ${challengeDateString} (UTC range: ${startDateForDailyChallengeQuery.toISOString()} to ${endDateForDailyChallengeQuery.toISOString()})`);
    
    const dailyChallenge = await DailyChallenge.findOne({
      date: { $gte: startDateForDailyChallengeQuery, $lt: endDateForDailyChallengeQuery },
    });

    if (!dailyChallenge) {
      logger.warn(`[ProcessRoundGuesses] DailyChallenge not found for date: ${challengeDateString} (query range ${startDateForDailyChallengeQuery.toISOString()} - ${endDateForDailyChallengeQuery.toISOString()}). Cannot store distributions.`);
      return;
    }

    logger.info(`[ProcessRoundGuesses] Found DailyChallenge ID: ${dailyChallenge._id}. Updating stats.roundGuessDistributions.`);
    
    // Ensure stats object exists
    if (!dailyChallenge.stats) {
        dailyChallenge.stats = {
            averageScore: 0,
            completions: 0,
            distributions: [],
            // processedDistribution will be handled by its own logic
        };
    }
    dailyChallenge.stats.roundGuessDistributions = processedRoundDistributions;
    
    await dailyChallenge.save();
    logger.info(`[ProcessRoundGuesses] Successfully stored round guess distributions for DailyChallenge ID: ${dailyChallenge._id} on date ${challengeDateString}.`);

  } catch (error) {
    logger.error(`[ProcessRoundGuesses] Error processing round guess distributions for date ${challengeDateString}:`, error);
    // Optionally, re-throw or handle more gracefully
  }
} 