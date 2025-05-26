// src/scripts/restoreRoundStats.ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';
// Assuming DailyChallenge model is correctly defined in its file
// and includes roundStatsFinalized field
import DailyChallengeLive, { DailyChallengeDoc } from '../models/DailyChallenge'; 

dotenv.config();

const LIVE_DB_URI = process.env.MONGODB_URI!;
// The TEMP_DB_URI will connect to the same database where dailychallenges_FROM_BACKUP is.
// Your mongorestore command used --uri=".../test", so the temp collection is in the 'test' DB.
// Mongoose will connect to the database specified in the URI.

// The specific UTC dates for the challenges you want to fix.
// IMPORTANT: These are YYYY-MM-DD and will be converted to Date objects representing midnight UTC.
const AFFECTED_CHALLENGE_NOMINAL_DATES = [
    "2025-05-09", // May 9, 2025
    "2025-04-24", // April 24, 2025
    "2025-05-12"  // May 12, 2025
];

async function restoreSpecificStatsAndFinalize() {
    if (AFFECTED_CHALLENGE_NOMINAL_DATES.length === 0) {

        return;
    }

    // A single connection is fine; we'll use different models for different collections.
    await mongoose.connect(LIVE_DB_URI);


    // Model for the live 'dailychallenges' collection (already imported as DailyChallengeLive)
    // Model for the backup 'dailychallenges_FROM_BACKUP' collection
    const DailyChallengeBackupModel = mongoose.model<DailyChallengeDoc>('DailyChallengeBackup', DailyChallengeLive.schema, 'dailychallenges_FROM_BACKUP');

    for (const nominalDateStr of AFFECTED_CHALLENGE_NOMINAL_DATES) {
        // Dates in MongoDB are stored as UTC. Assuming these nominal dates correspond to midnight UTC.
        const targetDateUTC = new Date(`${nominalDateStr}T00:00:00.000Z`);
      

        try {
            const backupDoc = await DailyChallengeBackupModel.findOne({ date: targetDateUTC });

            if (backupDoc && backupDoc.stats && backupDoc.stats.roundGuessDistributions) {
                const restoredRoundGuessDistributions = backupDoc.stats.roundGuessDistributions;
                
                const updateResult = await DailyChallengeLive.updateOne(
                    { date: targetDateUTC }, // Find the live document by the same date
                    {
                        $set: {
                            "stats.roundGuessDistributions": restoredRoundGuessDistributions,
                            roundStatsFinalized: true // Also set the finalized flag
                        }
                    }
                );

                if (updateResult.modifiedCount > 0) {
                  
                } else if (updateResult.matchedCount > 0) {
                 
                } else {
                 
                }
            } else {
               
            }
        } catch (error) {

        }
    }

    await mongoose.disconnect();

}

// Before running this script:
// 1. Ensure your `src/models/DailyChallenge.ts` has the `roundStatsFinalized` field in its schema. (You've confirmed this)
// 2. Ensure `test.dailychallenges_FROM_BACKUP` collection exists and has the correct data from your restore. (You've confirmed this)
// 3. Ensure your `.env` file has the correct `MONGODB_URI`.

restoreSpecificStatsAndFinalize().catch(err => {

    mongoose.disconnect(); // Ensure disconnect on unhandled error
});