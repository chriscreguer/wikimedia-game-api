// src/utils/emergencyArchiver.ts
import mongoose from 'mongoose';
import DailyChallenge from '../models/DailyChallenge'; // Adjust path if your models are elsewhere
import RoundGuess from '../models/RoundGuess';     // Adjust path
import { processAndStoreRoundGuessDistributions } from './distributionProcessor'; // Adjust path
import s3Client from './awsConfig';               // Adjust path
import { PutObjectCommand } from '@aws-sdk/client-s3';
import logger from './logger';                    // Adjust path

const ARCHIVE_S3_BUCKET_NAME_FROM_ENV = process.env.ARCHIVE_S3_BUCKET_NAME;
const ARCHIVE_S3_PREFIX = String(process.env.ARCHIVE_S3_PREFIX || 'round-guesses-archive/').replace(/\/$/, '');

export async function archiveSpecificDayEmergency(challengeDateString: string, challengeId: string): Promise<void> {
    logger.info(`[EmergencyArchiver] Starting emergency archival for challenge date: ${challengeDateString}, ID: ${challengeId}`);

    if (mongoose.connection.readyState !== 1) {
        logger.error("[EmergencyArchiver] MongoDB not connected. Aborting emergency archival.");
        // This function is called async from a live app, so re-throwing might be better
        // to make the calling .catch() block aware of the failure.
        throw new Error("MongoDB not connected for emergency archiver");
    }

    const canAttemptS3Archive = ARCHIVE_S3_BUCKET_NAME_FROM_ENV && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_REGION;

    // Fetch the specific challenge to ensure it's still not finalized,
    // in case multiple requests triggered this almost simultaneously.
    // Use mongoose.Types.ObjectId for converting string ID.
    const challengeDoc = await DailyChallenge.findById(new mongoose.Types.ObjectId(challengeId));
    if (!challengeDoc) {
        logger.warn(`[EmergencyArchiver] Challenge ID ${challengeId} for date ${challengeDateString} not found. Aborting.`);
        return;
    }
    if (challengeDoc.roundStatsFinalized) {
        logger.info(`[EmergencyArchiver] Challenge ${challengeId} (${challengeDateString}) was already marked finalized by another process. Aborting redundant emergency archival.`);
        return;
    }

    try {
        // 1. Finalize stats (recalculate curve points one last time)
        logger.info(`[EmergencyArchiver] Finalizing roundGuessDistributions for ${challengeDateString}.`);
        await processAndStoreRoundGuessDistributions(challengeDateString);
        logger.info(`[EmergencyArchiver] Successfully finalized roundGuessDistributions for ${challengeDateString}.`);

        // 2. Fetch all RoundGuess documents for this date
        const challengeUtcDate = new Date(`${challengeDateString}T00:00:00.000Z`);
        const allRoundGuessesForDate = await RoundGuess.find({ challengeDate: challengeUtcDate });

        if (allRoundGuessesForDate.length === 0) {
            logger.info(`[EmergencyArchiver] No RoundGuess documents found for ${challengeDateString} to archive, despite high completion count. This is unexpected. Marking as finalized.`);
            // Proceed to mark finalized even if no guesses are found, as the threshold was met.
            await DailyChallenge.updateOne({ _id: challengeDoc._id }, { $set: { roundStatsFinalized: true } });
            logger.info(`[EmergencyArchiver] Marked DailyChallenge ${challengeId} (${challengeDateString}) as roundStatsFinalized (no raw guesses found at archival).`);
            return;
        }
        logger.info(`[EmergencyArchiver] Found ${allRoundGuessesForDate.length} RoundGuess documents for ${challengeDateString}.`);

        // 3. Archive to S3
        let s3UploadSuccessful = false;
        if (canAttemptS3Archive) {
            const emergencyArchiveFileKey = `${ARCHIVE_S3_PREFIX}/${challengeDateString}/${challengeDateString}-EMERGENCY-initial.jsonl`;
            logger.info(`[EmergencyArchiver] Attempting to archive ${allRoundGuessesForDate.length} documents to S3: '${ARCHIVE_S3_BUCKET_NAME_FROM_ENV}/${emergencyArchiveFileKey}'.`);
            try {
                const body = allRoundGuessesForDate.map(doc => JSON.stringify(doc.toObject())).join('\n');
                await s3Client.send(new PutObjectCommand({
                    Bucket: ARCHIVE_S3_BUCKET_NAME_FROM_ENV!,
                    Key: emergencyArchiveFileKey,
                    Body: body,
                    ContentType: 'application/jsonl'
                }));
                logger.info(`[EmergencyArchiver] Successfully archived ${allRoundGuessesForDate.length} documents for ${challengeDateString} to S3 as '${emergencyArchiveFileKey}'.`);
                s3UploadSuccessful = true;
            } catch (s3Error: any) {
                logger.error(`[EmergencyArchiver] FAILED to archive RoundGuess documents to S3 for ${challengeDateString}. Error: ${s3Error.message}`, s3Error);
                // Do NOT delete from Mongo if S3 fails. Do NOT set finalized flag yet.
                // The nightly cron job will need to pick this up.
                throw s3Error; // Re-throw to be caught by the caller's .catch()
            }
        } else {
            logger.warn(`[EmergencyArchiver] S3 archival SKIPPED for ${challengeDateString} (S3 not configured). Data will NOT be deleted from MongoDB, and not marked finalized by this process.`);
            throw new Error(`S3 not configured for emergency archival of ${challengeDateString}`); // Re-throw
        }

        // 4. If S3 upload was successful, delete from MongoDB and set flag
        // This block only runs if s3UploadSuccessful is true (meaning canAttemptS3Archive was true and S3 PutObject succeeded)
        logger.info(`[EmergencyArchiver] S3 Archival successful. Proceeding with MongoDB deletion and finalizing for ${challengeDateString}.`);
        try {
            const deleteResult = await RoundGuess.deleteMany({ challengeDate: challengeUtcDate });
            logger.info(`[EmergencyArchiver] Successfully DELETED ${deleteResult.deletedCount} RoundGuess documents from MongoDB for ${challengeDateString}.`);

            await DailyChallenge.updateOne({ _id: challengeDoc._id }, { $set: { roundStatsFinalized: true } });
            logger.info(`[EmergencyArchiver] Marked DailyChallenge ${challengeId} (${challengeDateString}) as roundStatsFinalized.`);
        } catch (dbDeleteError: any) {
            logger.error(`[EmergencyArchiver] FAILED to delete RoundGuess documents from MongoDB or set flag for ${challengeDateString} after S3 success. Data is in S3. Manual cleanup of Mongo data may be needed. Flag may not be set. Error: ${dbDeleteError.message}`, dbDeleteError);
            throw dbDeleteError; // Re-throw
        }
    } catch (error: any) {
        logger.error(`[EmergencyArchiver] Critical error during emergency archival for ${challengeDateString}, ID: ${challengeId}. Error: ${error.message}`, error);
        throw error; // Re-throw for the caller's .catch()
    }
} 