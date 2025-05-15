// src/routes/admin.ts
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData, extractFilenameFromUrl } from '../utils/wikimediaHelper';
import logger from '../utils/logger';
import multer from 'multer'; 
import fs from 'fs';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multerS3 from 'multer-s3';
import s3Client, { s3BucketName } from '../utils/awsConfig';
import { processAndStoreRoundGuessDistributions } from '../utils/distributionProcessor';
import { archiveAndCleanupRoundGuesses } from '../scripts/archiveOldRoundGuesses';

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
        req.files.forEach(file => {
          if (file.path) {
            fs.unlinkSync(file.path);
          }
        });
      }
      return res.status(400).json({ error: 'Date is required and cannot be empty.' });
    }

    const challengeDate = new Date(date);

    if (isNaN(challengeDate.getTime())) {
      // Clean up uploaded files if date is invalid
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          if (file.path) {
            fs.unlinkSync(file.path);
          }
        });
      }
      return res.status(400).json({ error: 'Invalid date received from client.' });
    }

    // Process images
    let imageData: any[] = [];
    if (imagesOrderStr) {
      try {
        const imagesOrder = JSON.parse(imagesOrderStr);
        const uploadedFiles = req.files as Express.MulterS3.File[] || [];

        for (const imageInfo of imagesOrder) {
          if (imageInfo.type === 'wikimedia') {
            const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : '';
            if (filename) {
              const wikimediaData = await fetchImageData(filename);
              if (wikimediaData) {
                wikimediaData.year = imageInfo.year || wikimediaData.year;
                wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                imageData.push(wikimediaData);
              }
            }
          } else if (imageInfo.type === 'upload') {
            const uploadIndex = imageInfo.uploadIndex;
            if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex];
              const fileUrl = (file as Express.MulterS3.File).location;
              imageData.push({
                filename: file.originalname,
                title: file.originalname,
                url: fileUrl,
                year: imageInfo.year || new Date().getFullYear(),
                source: 'User Upload',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
              });
            }
          }
        }
      } catch (parseError) {
        // Clean up uploaded files on error
        if (req.files && Array.isArray(req.files)) {
          req.files.forEach(file => {
            if (file.path) {
              fs.unlinkSync(file.path);
            }
          });
        }
        return res.status(400).json({ error: 'Invalid imagesOrder format.' });
      }
    }

    // Ensure we have some images
    if (imageData.length === 0) {
      // Clean up uploaded files if no valid images
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          if (file.path) {
            fs.unlinkSync(file.path);
          }
        });
      }
      return res.status(400).json({ error: 'No valid images provided or processed' });
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
router.put('/daily-challenge/:id/edit', verifyAdmin, uploadWithErrorHandling, (async (req, res) => {
  try {
    const { id } = req.params;
    const { date, imagesOrder } = req.body;
    
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
    if (imagesOrder) {
      try {
        const orderData = typeof imagesOrder === 'string' ? JSON.parse(imagesOrder) : imagesOrder;
        logger.info(`Processing ${orderData.length} images`);
        const updatedImages: any[] = [];
        
        // Process each image
        for (const imageInfo of orderData) {
          logger.info(`Processing image of type: ${imageInfo.type}`);
          
          if (imageInfo.type === 'existing') {
            // Handle existing image
            const index = parseInt(imageInfo.originalIndex, 10);
            if (!isNaN(index) && index >= 0 && index < challenge.images.length) {
              // Get existing image data
              const existingImage = {
                filename: challenge.images[index].filename,
                title: challenge.images[index].title,
                url: challenge.images[index].url,
                year: challenge.images[index].year,
                source: challenge.images[index].source || 'Unknown',
                description: challenge.images[index].description || '',
                revealedDescription: challenge.images[index].revealedDescription || ''
              };
              
              // Update fields if provided
              if (imageInfo.year !== undefined) {
                existingImage.year = parseInt(imageInfo.year, 10);
              }
              if (imageInfo.description !== undefined) {
                existingImage.description = imageInfo.description;
              }
              if (imageInfo.revealedDescription !== undefined) {
                existingImage.revealedDescription = imageInfo.revealedDescription;
              }
              
              logger.info(`Adding existing image: ${existingImage.url}`);
              updatedImages.push(existingImage);
            } else {
              logger.warn(`Invalid existing image index: ${imageInfo.originalIndex}`);
            }
          } else if (imageInfo.type === 'wikimedia') {
            // Handle Wikimedia image
            const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : '';
            if (filename) {
              const wikimediaData = await fetchImageData(filename);
              if (wikimediaData) {
                wikimediaData.year = imageInfo.year || wikimediaData.year;
                wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                
                logger.info(`Adding Wikimedia image: ${wikimediaData.url}`);
                updatedImages.push(wikimediaData);
              } else {
                logger.warn(`Failed to fetch Wikimedia data for: ${filename}`);
              }
            } else {
              logger.warn(`Invalid Wikimedia URL: ${imageInfo.url}`);
            }
          } else if (imageInfo.type === 'upload') {
            // Handle new upload
            const uploadIndex = parseInt(imageInfo.uploadIndex, 10);
            logger.info(`Processing upload index: ${uploadIndex} (of ${uploadedFiles.length} files)`);
            
            if (!isNaN(uploadIndex) && uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex];
              logger.info(`Found uploaded file: ${file.originalname}`);
              
              // Use S3 file location directly
              const fileUrl = (file as Express.MulterS3.File).location;
              
              logger.info(`Created URL for uploaded file: ${fileUrl}`);
              
              updatedImages.push({
                filename: file.originalname,
                title: file.originalname || 'Uploaded image',
                url: fileUrl,
                year: imageInfo.year ? parseInt(imageInfo.year, 10) : new Date().getFullYear(),
                source: 'User Upload',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
              });
              
              logger.info(`Added uploaded image: ${fileUrl}`);
            } else {
              logger.warn(`Invalid upload index: ${uploadIndex}`);
            }
          }
        }
        
        // Replace images if we have new ones
        if (updatedImages.length > 0) {
          logger.info(`Replacing challenge images with ${updatedImages.length} updated images`);
          challenge.images = updatedImages;
        } else {
          logger.warn('No valid images to update');
          return res.status(400).json({ error: 'No valid images to update' });
        }
      } catch (error) {
        logger.error('Error processing image updates:', error);
        return res.status(400).json({ 
          error: 'Invalid image order data',
          details: error instanceof Error ? error.message : 'Unknown error'
        });
      }
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
}) as RequestHandler);

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
