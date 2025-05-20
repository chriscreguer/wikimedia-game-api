// src/routes/admin.ts
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData, extractFilenameFromUrl } from '../utils/wikimediaHelper';
import logger from '../utils/logger';
import multer from 'multer'; 
import fs from 'fs';
import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multerS3 from 'multer-s3';
import s3Client, { s3BucketName } from '../utils/awsConfig';
import { processAndStoreRoundGuessDistributions } from '../utils/distributionProcessor';
import { archiveAndCleanupRoundGuesses } from '../scripts/archiveOldRoundGuesses';
import { processAndStoreImageVariants, fetchImageFromUrl, deleteFromS3 } from '../utils/imageProcessor';
import { v4 as uuidv4 } from 'uuid';
import { WikimediaImage } from '../types/wikimedia';

const storage = multerS3({
  s3: s3Client,
  bucket: s3BucketName,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  metadata: function (req, file, cb) {
    cb(null, { fieldName: file.fieldname });
  },
  key: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const filename = file.fieldname + '-' + uniqueSuffix + ext;
    cb(null, filename);
  }
});

// File filter to accept images and videos
const fileFilter = (
  req: Express.Request, 
  file: Express.Multer.File, 
  cb: multer.FileFilterCallback
) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image and video files are allowed!') as any, false);
  }
};

// Set upload limits
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max file size
    files: 5 // Max 5 files at once
  },
  fileFilter: fileFilter
});

// Wrap multer in error handling middleware
const uploadWithErrorHandling = (req: Request, res: Response, next: Function) => {
  upload.array('uploadedFiles', 5)(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      logger.error('Multer error:', err);
      return res.status(400).json({ 
        error: 'File upload error',
        details: err.message,
        code: err.code
      });
    } else if (err) {
      logger.error('Upload error:', err);
      return res.status(400).json({ 
        error: 'File upload error',
        details: err.message
      });
    }
    next();
  });
};

async function getS3Url(key: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: s3BucketName,
    Key: key
  });
  
  try {
    // This URL will be valid for 1 week (604800 seconds)
    const url = await getSignedUrl(s3Client, command, { expiresIn: 604800 });
    return url;
  } catch (error) {
    logger.error('Error generating S3 URL:', error);
    return '';
  }
}

const router = express.Router();

// Admin authentication middleware - should be defined in this file or imported correctly
// Based on search, verifyAdmin is defined in this file itself.
const verifyAdmin: RequestHandler = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey; // Or however you get the key
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

function normalizeImageUrl(url: string): string {
  if (!url) return '';
  
  // If it's an S3 URL
  if (url.includes('amazonaws.com')) {
    return url; // No need to modify S3 URLs
  }
  
  // If it's an old uploaded image URL that hasn't been migrated
  if (url.includes('uploads')) {
    // Extract the filename
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    // Create S3 URL format
    return `https://${s3BucketName}.s3.amazonaws.com/${filename}`;
  }
  
  return url;
}

// Add this to admin.ts
router.get('/test-uploads', verifyAdmin, (req, res) => {
  const uploadsDir = path.join(__dirname, '../../uploads');
  
  fs.readdir(uploadsDir, (err, files) => {
    if (err) {
      return res.status(500).json({ 
        error: 'Failed to read uploads directory', 
        details: err.message,
        path: uploadsDir
      });
    }
    
    res.status(200).json({ 
      message: 'Uploads directory contents',
      path: uploadsDir,
      files: files
    });
  });
});

// Serve admin dashboard
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/admin.html'));
});


// In src/routes/admin.ts, near the top
router.post('/test-admin-post', (req, res) => {
  logger.info('[Admin Test] POST /admin/test-admin-post hit successfully');
  res.status(200).send('Admin POST test successful');
});

/**
 * Create a daily challenge from Wikimedia URL(s)
 * POST /admin/daily-challenge/create
 */
router.post('/daily-challenge/create', verifyAdmin, upload.array('uploadedFiles', 5), (async (req, res) => {
  try {
    const { date, imagesOrder: imagesOrderStr, append: appendStr } = req.body;
    const appendImages = appendStr === 'true';

    if (!date) {
      // Clean up uploaded files if date is missing
      if (req.files && Array.isArray(req.files)) {
        logger.warn(`Date is missing, cleaning up ${req.files.length} S3 objects from initial upload.`);
        for (const file of req.files as Express.MulterS3.File[]) {
          if (file.key) { // Check if S3 key exists
            await deleteFromS3(file.key); // Use your existing deleteFromS3 utility
          }
        }
      }
      return res.status(400).json({ error: 'Date is required and cannot be empty.' });
    }

    const challengeDate = new Date(date);

    if (isNaN(challengeDate.getTime())) {
      // Clean up uploaded files if date is invalid
      if (req.files && Array.isArray(req.files)) {
        logger.warn(`Invalid date, cleaning up ${req.files.length} S3 objects from initial upload.`);
        for (const file of req.files as Express.MulterS3.File[]) {
          if (file.key) { // Check if S3 key exists
            await deleteFromS3(file.key); // Use your existing deleteFromS3 utility
          }
        }
      }
      return res.status(400).json({ error: 'Invalid date received from client.' });
    }

    // Process images
    let imageData: WikimediaImage[] = [];
    if (imagesOrderStr) {
      try {
        const imagesOrder = JSON.parse(imagesOrderStr);
        const uploadedFiles = req.files as Express.MulterS3.File[] || [];

        for (const imageInfo of imagesOrder) {
          let originalImageBuffer: Buffer | null = null;
          let baseIdentifier: string = uuidv4(); // Used for S3 object naming (without extension)
          let originalS3KeyOfUpload: string | undefined = undefined; // Full S3 key of original multer upload for deletion

          if (imageInfo.type === 'wikimedia') {
            const wikimediaData = await fetchImageData(extractFilenameFromUrl(imageInfo.url) || '');
            if (wikimediaData && wikimediaData.url) {
              originalImageBuffer = await fetchImageFromUrl(wikimediaData.url);
              // baseIdentifier is already a new UUID for Wikimedia images
            } else {
              logger.warn(`Could not fetch Wikimedia data for URL: ${imageInfo.url}`);
              continue; // Skip this image
            }
          } else if (imageInfo.type === 'upload') {
            const uploadIndex = imageInfo.uploadIndex;
            if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex] as Express.MulterS3.File; // Ensure type cast
              originalS3KeyOfUpload = file.key; // This is the full S3 key from multer-s3

              const s3ObjectResponse = await s3Client.send(new GetObjectCommand({ Bucket: s3BucketName, Key: file.key }));
              if (s3ObjectResponse.Body) {
                originalImageBuffer = Buffer.from(await s3ObjectResponse.Body.transformToByteArray());
                // Derive a baseIdentifier from the original S3 key (without extension or path)
                const keyParts = file.key.split('/').pop()?.split('.') || [];
                keyParts.pop(); // Remove extension
                baseIdentifier = keyParts.join('.') || uuidv4(); // Fallback to UUID if stem is empty
              } else {
                logger.warn(`Failed to fetch uploaded file from S3: ${file.key}`);
                continue; // Skip this image
              }
            } else {
              logger.warn(`Invalid uploadIndex ${uploadIndex} for uploaded files.`);
              continue; // Skip this image
            }
          } else {
            logger.warn(`Unknown image type: ${imageInfo.type}`);
            continue; // Skip this image
          }

          if (originalImageBuffer) {
            const processedInfo = await processAndStoreImageVariants(originalImageBuffer, baseIdentifier);
            logger.info('[AdminTS] ProcessedInfo from imageProcessor:', processedInfo);
            if (processedInfo.cloudFrontUrl) {
              imageData.push({
                filename: imageInfo.type === 'upload' ? (uploadedFiles[imageInfo.uploadIndex] as Express.MulterS3.File).originalname : (extractFilenameFromUrl(imageInfo.url) || baseIdentifier),
                title: imageInfo.type === 'upload' ? (uploadedFiles[imageInfo.uploadIndex] as Express.MulterS3.File).originalname : (extractFilenameFromUrl(imageInfo.url) || baseIdentifier),
                url: processedInfo.cloudFrontUrl, // Store the CloudFront URL for the .webp variant
                year: parseInt(imageInfo.year) || new Date().getFullYear(),
                source: imageInfo.type === 'upload' ? 'User Upload' : 'Wikimedia Commons',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || '',
                s3BaseIdentifier: processedInfo.s3BaseIdentifier // Store just the unique ID part
              });

              // Delete the original file uploaded by multer-s3 if it's different from the variants and was an upload
              if (imageInfo.type === 'upload' && originalS3KeyOfUpload) {
                const originalExtension = originalS3KeyOfUpload.split('.').pop()?.toLowerCase();
                if (originalExtension && !['webp', 'jpg', 'jpeg'].includes(originalExtension)) {
                  await deleteFromS3(originalS3KeyOfUpload);
                } else if (originalS3KeyOfUpload !== `game-images/${baseIdentifier}.${originalExtension}`) {
                    // If original was already webp/jpg but not under game-images/ path or different base, delete it too
                    // This logic might need refinement based on how multer-s3 names files vs. your baseIdentifier
                    await deleteFromS3(originalS3KeyOfUpload);
                }
              }
            } else {
              logger.warn(`Failed to process variants for baseIdentifier: ${baseIdentifier}`);
            }
          }
        }
      } catch (error) {
        // Clean up uploaded files on error
        if (req.files && Array.isArray(req.files)) {
          logger.warn(`Invalid imagesOrder format, cleaning up ${req.files.length} S3 objects from initial upload.`);
          for (const file of req.files as Express.MulterS3.File[]) {
            if (file.key) { // Check if S3 key exists
              await deleteFromS3(file.key); // Use your existing deleteFromS3 utility
            }
          }
        }
        return res.status(400).json({ error: 'Invalid imagesOrder format.' });
      }
    }

    // Ensure we have some images
    if (imageData.length === 0) {
      // If no images were successfully processed and added to imageData,
      // clean up any files that were originally uploaded by multer-s3.
      if (req.files && Array.isArray(req.files) && req.files.length > 0) {
        logger.warn(`No valid image data was processed from inputs. Cleaning up ${req.files.length} initial S3 objects uploaded by multer-s3.`);
        for (const file of req.files as Express.MulterS3.File[]) { // Cast to ensure 'key' property
          if (file.key) {
            await deleteFromS3(file.key);
          }
        }
      }
      return res.status(400).json({ error: 'No valid images provided or processed. All initial uploads have been cleaned up if applicable.' });
    }

    // Force create path for testing
    const forceCreate = true;
    let existingChallenge = null;

    if (!forceCreate) {
      // Original logic to find existing challenge
      const startDate = new Date(challengeDate);
      startDate.setUTCHours(0, 0, 0, 0);
      const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      existingChallenge = await DailyChallenge.findOne({ date: { $gte: startDate, $lt: endDate } });
    }

    if (existingChallenge && !forceCreate) {
      if (appendImages) {
        existingChallenge.images.push(...imageData);
      } else {
        existingChallenge.images = imageData;
      }

      await existingChallenge.save();

      return res.status(200).json({
        message: 'Daily challenge updated successfully',
        challenge: {
          id: existingChallenge._id,
          date: existingChallenge.date,
          imageCount: existingChallenge.images.length
        }
      });
    } else {
      // Create new challenge
      const newChallenge = new DailyChallenge({
        date: challengeDate,
        images: imageData,
        stats: { averageScore: 0, completions: 0, distributions: [] },
        active: true
      });

      await newChallenge.save();

      res.status(201).json({
        message: 'Daily challenge created successfully',
        challenge: {
          id: newChallenge._id,
          date: newChallenge.date,
          imageCount: newChallenge.images.length
        }
      });
    }

  } catch (error) {
    // Clean up uploaded files on error
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files as Express.MulterS3.File[]) {
        try {
          if (file.key) {
            await s3Client.send(new DeleteObjectCommand({
              Bucket: s3BucketName,
              Key: file.key
            }));
          }
        } catch (deleteErr) {
          logger.error(`Failed to delete file ${file.key || file.originalname} from S3:`, deleteErr);
        }
      }
    }

    logger.error('Error creating daily challenge:', error);
    res.status(500).json({ error: 'Failed to create daily challenge' });
  }
}) as RequestHandler);

// In the GET /daily-challenges route
router.get('/daily-challenges', verifyAdmin, async (req: Request, res: Response) => {
  try {
    const challenges = await DailyChallenge.find().sort({ date: -1 });
    
    // Log the first challenge's images for debugging
    if (challenges.length > 0 && challenges[0].images.length > 0) {
      logger.info('First challenge images:', JSON.stringify(challenges[0].images));
    }
    
    // Return challenges with plain dates for easier frontend processing
    const plainChallenges = challenges.map(challenge => {
      const plain = { ...challenge.toObject(), plainDate: '' };
      plain.plainDate = challenge.date.toISOString().split('T')[0];
      return plain;
    });
    
    res.status(200).json(plainChallenges);
  } catch (error) {
    logger.error('Error fetching daily challenges:', error);
    res.status(500).json({ error: 'Failed to fetch daily challenges' });
  }
});

/**
 * Edit a daily challenge
 * PUT /admin/daily-challenge/:id/edit
 */
router.put('/daily-challenge/:id/edit', verifyAdmin, upload.array('uploadedFiles', 5), async (req, res) => {
  try {
    const { id } = req.params;
    const { date, imagesOrder: imagesOrderStr, isHardMode, source, creatorUserId, hints, facts, solutionText, articleSource } = req.body;
    
    logger.info(`Editing challenge ${id}`);
    const uploadedFiles = req.files as Express.Multer.File[] || [];
    logger.info(`Received ${uploadedFiles.length} uploaded files`);
    
    // Find the challenge
    const challenge = await DailyChallenge.findById(id);
    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    // Update date if provided
    if (date) {
      // Assuming 'date' from req.body is the full ISO string like "YYYY-MM-DDTHH:00:00.000Z" sent by frontend
      const parsedDate = new Date(date);
      if (isNaN(parsedDate.getTime())) {
        logger.error(`Admin Edit: Received invalid date string in body: ${date}`);
        // Optionally return a 400 error here if date is mandatory on edit and invalid
      } else {
        challenge.date = parsedDate; // Assign the parsed UTC date object
        logger.info(`Admin Edit: Updating challenge ${id} date to ${challenge.date.toISOString()}`);
      }
    }

    // Process image updates if provided
    if (imagesOrderStr) {
      const imagesOrder = JSON.parse(imagesOrderStr);
      const uploadedFiles = req.files as Express.MulterS3.File[] || [];
      const newImageData: WikimediaImage[] = [];

      logger.info(`[Admin Edit ${id}] Before loop - challenge.images:`, JSON.stringify(challenge.images));
      logger.info(`[Admin Edit ${id}] Before loop - incoming imagesOrder:`, JSON.stringify(imagesOrder));

      for (const imageInfo of imagesOrder) {
        if (imageInfo.type === 'existing') {
          // Find the existing image data from challengeToUpdate.images
          logger.info(`[Admin Edit ${id}] Existing image find - imageInfo.url: ${imageInfo.url}, imageInfo.s3BaseIdentifier: ${imageInfo.s3BaseIdentifier}`);
          const existingImage = challenge.images.find(img => img.url === imageInfo.url || (img.s3BaseIdentifier && img.s3BaseIdentifier === imageInfo.s3BaseIdentifier));
          logger.info(`[Admin Edit ${id}] Existing image find - existingImage:`, JSON.stringify(existingImage));
          if (existingImage) {
            const imageToPush = {
              ...existingImage, // Spread existing data
              // Update specific fields if they are part of imageInfo and meant to be editable here
              year: parseInt(imageInfo.year) || existingImage.year,
              description: imageInfo.description || existingImage.description,
              revealedDescription: imageInfo.revealedDescription || existingImage.revealedDescription,
              title: imageInfo.title || existingImage.title, // Preserve or update title
              // url and s3BaseIdentifier are preserved from existingImage unless explicitly changed
            };
            logger.info(`[Admin Edit ${id}] Existing image push - imageToPush:`, JSON.stringify(imageToPush));
            newImageData.push(imageToPush);
          } else {
            logger.warn(`[Admin Edit ${id}] Could not find existing image for URL/ID: ${imageInfo.url || imageInfo.s3BaseIdentifier}`);
          }
        } else { // 'wikimedia' or 'upload' (new images)
          let originalImageBuffer: Buffer | null = null;
          let baseIdentifier: string = uuidv4();
          let originalS3KeyOfUpload: string | undefined = undefined;

          if (imageInfo.type === 'wikimedia') {
            const wikimediaData = await fetchImageData(extractFilenameFromUrl(imageInfo.url) || '');
            if (wikimediaData && wikimediaData.url) {
              originalImageBuffer = await fetchImageFromUrl(wikimediaData.url);
            } else {
              logger.warn(`Could not fetch Wikimedia data for URL: ${imageInfo.url}`);
              continue;
            }
          } else if (imageInfo.type === 'upload') {
            const uploadIndex = imageInfo.uploadIndex;
            if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex] as Express.MulterS3.File;
              originalS3KeyOfUpload = file.key;

              const s3ObjectResponse = await s3Client.send(new GetObjectCommand({ Bucket: s3BucketName, Key: file.key }));
              if (s3ObjectResponse.Body) {
                originalImageBuffer = Buffer.from(await s3ObjectResponse.Body.transformToByteArray());
                const keyParts = file.key.split('/').pop()?.split('.') || [];
                keyParts.pop();
                baseIdentifier = keyParts.join('.') || uuidv4();
              } else {
                logger.warn(`Failed to fetch uploaded file from S3: ${file.key}`);
                continue;
              }
            } else {
              logger.warn(`Invalid uploadIndex ${uploadIndex} for uploaded files.`);
              continue;
            }
          } else {
            logger.warn(`Unknown image type: ${imageInfo.type}`);
            continue;
          } 

          if (originalImageBuffer) {
            const processedInfo = await processAndStoreImageVariants(originalImageBuffer, baseIdentifier);
            logger.info('[AdminTS] ProcessedInfo from imageProcessor:', processedInfo);
            if (processedInfo.cloudFrontUrl) {
              newImageData.push({
                filename: imageInfo.type === 'upload' ? (uploadedFiles[imageInfo.uploadIndex] as Express.MulterS3.File).originalname : (extractFilenameFromUrl(imageInfo.url) || baseIdentifier),
                title: imageInfo.type === 'upload' ? (uploadedFiles[imageInfo.uploadIndex] as Express.MulterS3.File).originalname : (extractFilenameFromUrl(imageInfo.url) || baseIdentifier),
                url: processedInfo.cloudFrontUrl,
                year: parseInt(imageInfo.year) || new Date().getFullYear(),
                source: imageInfo.type === 'upload' ? 'User Upload' : 'Wikimedia Commons',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || '',
                s3BaseIdentifier: processedInfo.s3BaseIdentifier
              });

              if (imageInfo.type === 'upload' && originalS3KeyOfUpload) {
                 const originalExtension = originalS3KeyOfUpload.split('.').pop()?.toLowerCase();
                if (originalExtension && !['webp', 'jpg', 'jpeg'].includes(originalExtension)) {
                  await deleteFromS3(originalS3KeyOfUpload);
                } else if (originalS3KeyOfUpload !== `game-images/${baseIdentifier}.${originalExtension}`) {
                    await deleteFromS3(originalS3KeyOfUpload);
                }
              }
            } else {
              logger.warn(`Failed to process variants for new image with baseIdentifier: ${baseIdentifier}`);
            }
          }
        }
      }
      logger.info(`[Admin Edit ${id}] After loop - newImageData:`, JSON.stringify(newImageData));
      challenge.images = newImageData;
      logger.info(`[Admin Edit ${id}] Before save - challenge.images:`, JSON.stringify(challenge.images));
    }

    // Save the updated challenge
    await challenge.save();
    
    logger.info(`Challenge ${id} updated successfully with ${challenge.images.length} images`);
    
    res.status(200).json({ 
      message: 'Challenge updated successfully',
      challenge: {
        id: challenge._id,
        date: challenge.date,
        imageCount: challenge.images.length
      }
    });
  } catch (error) {
    logger.error('Error updating challenge:', error);
    
    // Clean up uploaded files on error
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files as Express.MulterS3.File[]) {
        try {
          if (file.key) {  // Only try to delete if the file was actually uploaded to S3
            await s3Client.send(new DeleteObjectCommand({
              Bucket: s3BucketName,
              Key: file.key
            }));
            logger.info(`Cleaned up S3 file: ${file.key}`);
          }
        } catch (deleteErr) {
          logger.error(`Failed to delete file ${file.key} from S3:`, deleteErr);
        }
      }
    }
    
    res.status(500).json({ 
      error: 'Failed to update daily challenge',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Delete a daily challenge
 * DELETE /admin/daily-challenge/:id
 */
router.delete('/daily-challenge/:id', verifyAdmin, (async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await DailyChallenge.findByIdAndDelete(id);
    
    if (!result) {
      return res.status(404).json({ error: 'Challenge not found' });
    }
    
    res.status(200).json({ message: 'Challenge deleted successfully' });
  } catch (error) {
    logger.error('Error deleting daily challenge:', error);
    res.status(500).json({ error: 'Failed to delete daily challenge' });
  }
}) as RequestHandler);

/**
 * POST /api/admin/daily-challenge/process-round-guesses
 * Process raw round guesses and store aggregated distributions for a given date.
 * Admin only.
 */
router.post('/daily-challenge/process-round-guesses', verifyAdmin, (async (req: Request, res: Response) => {
  const { date } = req.body;

  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    logger.warn(`[Admin ProcessRoundGuesses] Invalid date format received: ${date}`);
    return res.status(400).json({ error: 'Invalid date format. Please use YYYY-MM-DD.' });
  }

  try {
    logger.info(`[Admin ProcessRoundGuesses] Received request to process round guesses for date: ${date}`);
    await processAndStoreRoundGuessDistributions(date);
    logger.info(`[Admin ProcessRoundGuesses] Successfully initiated round guess processing for date: ${date}. Check logs for details.`);
    res.status(200).json({ message: `Successfully initiated round guess processing for ${date}. Check server logs for completion status and details.` });
  } catch (error) {
    logger.error(`[Admin ProcessRoundGuesses] Error triggering round guess processing for date ${date}:`, error);
    res.status(500).json({ error: 'Failed to trigger round guess processing. See server logs.' });
  }
}) as RequestHandler);

// @ts-ignore
router.post('/trigger-archive-script', verifyAdmin, async (req: Request, res: Response) => {
    logger.info('[Admin Endpoint] Received request to trigger archive script.');
    try {
        // Call the function, passing true to indicate it's launched by the app
        // This will prevent it from managing the mongoose connection itself
        archiveAndCleanupRoundGuesses(true) // <<< PASS true HERE
            .then(() => {
                logger.info('[Admin Endpoint] archiveAndCleanupRoundGuesses finished processing (async).');
            })
            .catch(err => {
                // This catch is for errors within the promise of archiveAndCleanupRoundGuesses
                logger.error('[Admin Endpoint] archiveAndCleanupRoundGuesses promise rejected an error:', err);
            });

        res.status(202).json({ message: "Archive script triggered. Check server logs for progress and completion." });
    } catch (error: any) {
        // This catch is for synchronous errors in setting up the call
        logger.error('[Admin Endpoint] Error synchronously triggering archive script:', error);
        res.status(500).json({ error: 'Failed to trigger archive script.', details: error.message });
    }
});

export default router;
