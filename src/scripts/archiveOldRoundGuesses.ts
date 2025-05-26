// src/scripts/archiveOldRoundGuesses.ts
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import { subDays } from 'date-fns';
import DailyChallenge from '../models/DailyChallenge';
import RoundGuess from '../models/RoundGuess';
import { processAndStoreRoundGuessDistributions } from '../utils/distributionProcessor';
import s3Client from '../utils/awsConfig';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import logger from '../utils/logger';



dotenv.config(); // For standalone execution

// --- Configuration ---
const TARGET_TIMEZONE = process.env.TARGET_TIMEZONE || 'America/New_York';
const ARCHIVE_S3_BUCKET_NAME_FROM_ENV = process.env.ARCHIVE_S3_BUCKET_NAME;
const ARCHIVE_S3_PREFIX = (process.env.ARCHIVE_S3_PREFIX || 'round-guesses-archive/').replace(/\/$/, ''); // Ensure no trailing slash initially
const PROCESS_CHALLENGES_OLDER_THAN_DAYS: number = parseInt(process.env.PROCESS_CHALLENGES_OLDER_THAN_DAYS || "1", 10);
// --- End Configuration --- 

export async function archiveAndCleanupRoundGuesses(isLaunchedByApp?: boolean) {
    logger.info(`[ArchiveScript] Starting archival process. Launched by app: ${!!isLaunchedByApp}`);

    if (!isLaunchedByApp) { // <<< Only connect if NOT launched by app
        const connectionString = process.env.MONGODB_URI;
        if (!connectionString) {
            logger.error("[ArchiveScript] MONGODB_URI environment variable not set for standalone run. Exiting.");
            process.exit(1);
        }
        if (mongoose.connection.readyState !== 1 && mongoose.connection.readyState !== 2) { // 1 = connected, 2 = connecting
             await mongoose.connect(connectionString);
             logger.info("[ArchiveScript] Standalone Run: Successfully connected to MongoDB.");
        } else {
             logger.info("[ArchiveScript] Standalone Run: MongoDB connection already established or connecting.");
        }
    } else {
        if (mongoose.connection.readyState !== 1) { // Check if app's connection is live
            logger.error("[ArchiveScript] Launched by App: MongoDB is not connected as expected. Aborting.");
            // Throw an error or return early to prevent operations on a disconnected DB
            throw new Error("MongoDB not connected when script was called by app.");
        }
        logger.info("[ArchiveScript] Launched by App: Using existing MongoDB connection.");
    }

    const canAttemptS3Archive = ARCHIVE_S3_BUCKET_NAME_FROM_ENV && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

    if (ARCHIVE_S3_BUCKET_NAME_FROM_ENV && !canAttemptS3Archive) {
         logger.warn(`[ArchiveScript] ARCHIVE_S3_BUCKET_NAME ('${ARCHIVE_S3_BUCKET_NAME_FROM_ENV}') is set, but AWS credentials seem incomplete. S3 archival will be SKIPPED.`);
    }
    logger.info(`[ArchiveScript] Processing challenges older than ${PROCESS_CHALLENGES_OLDER_THAN_DAYS} day(s).`);
    logger.info(`[ArchiveScript] S3 Archival is ${canAttemptS3Archive ? `ENABLED (Bucket: ${ARCHIVE_S3_BUCKET_NAME_FROM_ENV})` : 'DISABLED (S3 not fully configured)'}.`);


    try {
        const now = new Date();
        const dateToProcessBefore = subDays(now, PROCESS_CHALLENGES_OLDER_THAN_DAYS);
        const dateStringForCutoff_ET = formatInTimeZone(dateToProcessBefore, TARGET_TIMEZONE, 'yyyy-MM-dd');
        const thresholdDateUtc = toZonedTime(`${dateStringForCutoff_ET}T00:00:00`, TARGET_TIMEZONE);

        logger.info(`[ArchiveScript] Will process challenges with a 'date' field strictly less than ${thresholdDateUtc.toISOString()} (derived from TARGET_TIMEZONE date < ${dateStringForCutoff_ET}).`);

        const challengesToProcess = await DailyChallenge.find({ date: { $lt: thresholdDateUtc } }).sort({ date: 1 });

        if (challengesToProcess.length === 0) {
            logger.info("[ArchiveScript] No past challenges found matching the criteria for initial processing or delta archival.");
        } else {
            logger.info(`[ArchiveScript] Found ${challengesToProcess.length} past challenge(s) to potentially process.`);
        }

        for (const challenge of challengesToProcess) {
            const challengeUtcDate = challenge.date;
            const challengeDateStringForProcessing = formatInTimeZone(challengeUtcDate, 'UTC', 'yyyy-MM-dd'); // Nominal date string YYYY-MM-DD

            logger.info(`[ArchiveScript] === Processing challenge for date: ${challengeDateStringForProcessing} (ID: ${challenge._id}) ===`);

            if (challenge.roundStatsFinalized) {
                // This challenge's main stats ARE finalized.
                // Look for any NEW RoundGuess data submitted since the last cleanup for this date.
                logger.info(`[ArchiveScript] Challenge ${challenge._id} (${challengeDateStringForProcessing}) is ALREADY FINALIZED. Checking for new round guesses to archive (delta).`);
                const newRoundGuesses = await RoundGuess.find({ challengeDate: challengeUtcDate });

                if (newRoundGuesses.length > 0) {
                    logger.info(`[ArchiveScript] Found ${newRoundGuesses.length} new RoundGuess documents for already finalized challenge ${challengeDateStringForProcessing}.`);
                    
                    let s3DeltaUploadSuccessful = false;
                    if (canAttemptS3Archive) {
                        const timestampForDelta = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-'); // Make it filename friendly
                        const deltaFileKey = `${ARCHIVE_S3_PREFIX}/${challengeDateStringForProcessing}/delta_${timestampForDelta}.jsonl`;
                        logger.info(`[ArchiveScript] Attempting to archive ${newRoundGuesses.length} new guesses (delta) to S3: '${ARCHIVE_S3_BUCKET_NAME_FROM_ENV}/${deltaFileKey}'.`);
                        try {
                            const body = newRoundGuesses.map(doc => JSON.stringify(doc.toObject())).join('\n');
                            await s3Client.send(new PutObjectCommand({
                                Bucket: ARCHIVE_S3_BUCKET_NAME_FROM_ENV!,
                                Key: deltaFileKey,
                                Body: body,
                                ContentType: 'application/jsonl'
                            }));
                            logger.info(`[ArchiveScript] Successfully archived ${newRoundGuesses.length} new guesses (delta) for ${challengeDateStringForProcessing} to S3 as '${deltaFileKey}'.`);
                            s3DeltaUploadSuccessful = true;
                        } catch (s3Error: any) {
                            logger.error(`[ArchiveScript] FAILED to archive NEW RoundGuesses (delta) to S3 for ${challengeDateStringForProcessing}. These guesses will remain in MongoDB. Error: ${s3Error.message}`, s3Error);
                        }
                    } else {
                        logger.warn(`[ArchiveScript] S3 archival SKIPPED for NEW RoundGuesses (delta) for ${challengeDateStringForProcessing} (S3 not configured). These guesses will remain in MongoDB.`);
                    }

                    if (s3DeltaUploadSuccessful) {
                        try {
                            // Delete only the newly processed delta guesses from MongoDB
                            const idsToDelete = newRoundGuesses.map(rg => rg._id);
                            const deleteResult = await RoundGuess.deleteMany({ _id: { $in: idsToDelete } });
                            logger.info(`[ArchiveScript] Successfully DELETED ${deleteResult.deletedCount} new RoundGuesses (delta) from MongoDB for finalized challenge ${challengeDateStringForProcessing}.`);
                        } catch (deleteError: any) {
                            logger.error(`[ArchiveScript] FAILED to delete NEW RoundGuesses (delta) from MongoDB for ${challengeDateStringForProcessing} after S3 success. Error: ${deleteError.message}`, deleteError);
                        }
                    }
                } else {
                    logger.info(`[ArchiveScript] No new RoundGuess documents to archive (delta) for already finalized challenge ${challengeDateStringForProcessing}.`);
                }
            } else {
                // This challenge is NOT YET FINALIZED. Perform the original full processing.
                logger.info(`[ArchiveScript] Challenge ${challenge._id} (${challengeDateStringForProcessing}) is NOT YET FINALIZED. Performing initial processing.`);
                try {
                    logger.info(`[ArchiveScript] Step 1: Updating/Finalizing roundGuessDistributions in DailyChallenge for ${challengeDateStringForProcessing}.`);
                    await processAndStoreRoundGuessDistributions(challengeDateStringForProcessing);
                    logger.info(`[ArchiveScript] Successfully updated/finalized roundGuessDistributions for ${challengeDateStringForProcessing}.`);
                } catch (e: any) {
                    logger.error(`[ArchiveScript] FAILED to update/finalize roundGuessDistributions for ${challengeDateStringForProcessing}. Skipping further processing for this date. Flag will not be set. Error: ${e.message}`, e);
                    continue; // Skip to next challenge if stats finalization fails
                }

                const allRoundGuessesForDate = await RoundGuess.find({ challengeDate: challengeUtcDate });

                if (allRoundGuessesForDate.length === 0) {
                    logger.info(`[ArchiveScript] No RoundGuess documents found for ${challengeDateStringForProcessing} during initial processing.`);
                    try {
                        await DailyChallenge.updateOne( { _id: challenge._id }, { $set: { roundStatsFinalized: true } });
                        logger.info(`[ArchiveScript] Marked DailyChallenge ${challenge._id} (${challengeDateStringForProcessing}) as roundStatsFinalized (no raw guesses found).`);
                    } catch (flagError: any) {
                        logger.error(`[ArchiveScript] FAILED to mark DailyChallenge ${challenge._id} as roundStatsFinalized (no raw guesses found). Error: ${flagError.message}`, flagError);
                    }
                    continue;
                }
                logger.info(`[ArchiveScript] Found ${allRoundGuessesForDate.length} RoundGuess documents for initial processing of ${challengeDateStringForProcessing}.`);

                let s3InitialUploadSuccessful = false;
                if (canAttemptS3Archive) {
                    const initialArchiveFileKey = `${ARCHIVE_S3_PREFIX}/${challengeDateStringForProcessing}/${challengeDateStringForProcessing}-initial.jsonl`;
                    logger.info(`[ArchiveScript] Attempting to archive ${allRoundGuessesForDate.length} initial documents to S3: '${ARCHIVE_S3_BUCKET_NAME_FROM_ENV}/${initialArchiveFileKey}'.`);
                    try {
                        const body = allRoundGuessesForDate.map(doc => JSON.stringify(doc.toObject())).join('\n');
                        await s3Client.send(new PutObjectCommand({
                            Bucket: ARCHIVE_S3_BUCKET_NAME_FROM_ENV!,
                            Key: initialArchiveFileKey,
                            Body: body,
                            ContentType: 'application/jsonl'
                        }));
                        logger.info(`[ArchiveScript] Successfully archived ${allRoundGuessesForDate.length} initial documents for ${challengeDateStringForProcessing} to S3 as '${initialArchiveFileKey}'.`);
                        s3InitialUploadSuccessful = true;
                    } catch (s3Error: any) {
                        logger.error(`[ArchiveScript] FAILED to archive initial RoundGuess documents to S3 for ${challengeDateStringForProcessing}. Error: ${s3Error.message}`, s3Error);
                    }
                } else {
                    logger.warn(`[ArchiveScript] S3 archival SKIPPED for initial RoundGuesses for ${challengeDateStringForProcessing} (S3 not configured). Data will NOT be deleted from MongoDB unless this logic is changed.`);
                    // For initial finalization, if S3 is the goal but not configured, we should NOT delete.
                    s3InitialUploadSuccessful = false;
                }

                if (s3InitialUploadSuccessful) {
                    logger.info(`[ArchiveScript] Initial S3 Archival successful. Proceeding with MongoDB deletion and finalizing for ${challengeDateStringForProcessing}.`);
                    try {
                        const deleteResult = await RoundGuess.deleteMany({ challengeDate: challengeUtcDate });
                        logger.info(`[ArchiveScript] Successfully DELETED ${deleteResult.deletedCount} RoundGuess documents from MongoDB for ${challengeDateStringForProcessing}.`);

                        await DailyChallenge.updateOne( { _id: challenge._id }, { $set: { roundStatsFinalized: true } });
                        logger.info(`[ArchiveScript] Marked DailyChallenge ${challenge._id} (${challengeDateStringForProcessing}) as roundStatsFinalized.`);
                    } catch (dbDeleteError: any) {
                        logger.error(`[ArchiveScript] FAILED to delete RoundGuess documents from MongoDB or set flag for ${challengeDateStringForProcessing} after S3 success. Error: ${dbDeleteError.message}`, dbDeleteError);
                    }
                } else {
                    logger.warn(`[ArchiveScript] SKIPPING MongoDB deletion and finalization for ${challengeDateStringForProcessing} because initial S3 archival was not successful or not attempted due to configuration.`);
                }
            }
        } // End of for...of loop

    } catch (error: any) {
        logger.error(`[ArchiveScript] A critical error occurred during the main execution block: ${error.message}`, error);
        // If an error happens in the main block, we might not want to disconnect if launched by app
        if (!isLaunchedByApp) { throw error; } // Re-throw for standalone to be caught by outer catch
        // If launched by app, the error is logged, but we don't disconnect here.
    } finally {
        if (!isLaunchedByApp && mongoose.connection.readyState === 1) { // <<< Only disconnect if standalone AND connected
            await mongoose.disconnect();
            logger.info("[ArchiveScript] Standalone Run: MongoDB connection closed.");
        } else if (isLaunchedByApp) {
            logger.info("[ArchiveScript] Launched by App: Script logic finished. Leaving MongoDB connection managed by app.");
        }
    }
}

// This block ensures the script runs when executed directly with `node`
if (require.main === module) {
    archiveAndCleanupRoundGuesses(false).catch(e => { // <<< PASS false for standalone
        logger.error("[ArchiveScript] Unhandled error at the top level of standalone script execution.", e);
        // Ensure disconnection if standalone and an error occurs before normal finally block
        if (mongoose.connection && mongoose.connection.readyState === 1) {
            mongoose.disconnect();
        }
        process.exit(1);
    });
}