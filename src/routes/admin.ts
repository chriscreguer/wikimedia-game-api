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
import sharp from 'sharp';
import axios from 'axios';
import { Readable } from 'stream';

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

// Helper function to download an image buffer from S3 or a URL
async function downloadImage(sourceUrl: string): Promise<Buffer> {
  logger.info(`Attempting to download image from: ${sourceUrl}`);
  if (sourceUrl.includes('amazonaws.com')) {
    // Download from S3
    const key = sourceUrl.split('.amazonaws.com/')[1].split('?')[0]; // Extract key, handle signed URLs
    logger.info(`Downloading from S3 with key: ${key}`);
    const command = new GetObjectCommand({
      Bucket: s3BucketName,
      Key: key,
    });
    const { Body } = await s3Client.send(command);
    if (!Body || !(Body instanceof Readable)) {
      throw new Error('Failed to retrieve S3 object body or body is not readable');
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of Body as Readable) {
      chunks.push(chunk as Uint8Array);
    }
    logger.info(`Successfully downloaded from S3: ${key}`);
    return Buffer.concat(chunks);
  } else {
    // Download from public URL (like Wikimedia)
    logger.info(`Downloading from public URL: ${sourceUrl}`);
    const response = await axios<ArrayBuffer>({
      method: 'get',
      url: sourceUrl,
      responseType: 'arraybuffer',
    });
    logger.info(`Successfully downloaded from public URL: ${sourceUrl}`);
    return Buffer.from(response.data);
  }
}

// Helper function to upload processed image buffer to S3
async function uploadProcessedToS3(buffer: Buffer, originalKey: string, format: 'webp' | 'jpeg'): Promise<string> {
  const fileExtension = format;
  const newKey = `previews/${path.basename(originalKey, path.extname(originalKey))}.${fileExtension}`;
  const contentType = format === 'webp' ? 'image/webp' : 'image/jpeg';
  logger.info(`Uploading processed ${format} image to S3 with key: ${newKey}, ContentType: ${contentType}`);

  const command = new PutObjectCommand({
    Bucket: s3BucketName,
    Key: newKey,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read' // Make previews publicly accessible
  });

  await s3Client.send(command);
  const s3Url = `https://${s3BucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${newKey}`;
  logger.info(`Successfully uploaded ${format} preview to S3: ${s3Url}`);
  return s3Url;
}

const router = express.Router();

// Admin authentication middleware - using the same key as in images.ts
const verifyAdmin: RequestHandler = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  
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
    let finalImageData: any[] = [];
    if (imagesOrderStr) {
      try {
        const imagesOrder = JSON.parse(imagesOrderStr);
        const uploadedFiles = req.files as Express.MulterS3.File[] || [];
        let uploadCounter = 0; // Keep track of which uploaded file corresponds to an 'upload' type

        for (const imageInfo of imagesOrder) {
          let originalJpegUrl: string | null = null;
          let baseImageData: any = {}; // Store common data
          let s3Key: string | null = null; // Store S3 key for uploads if available
          let filenameForPreviews: string | null = null; // Filename for preview generation

          if (imageInfo.type === 'wikimedia') {
            const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : null;
            if (filename) {
              const wikimediaData = await fetchImageData(filename);
              if (wikimediaData) {
                originalJpegUrl = wikimediaData.originalJpegUrl;
                filenameForPreviews = filename;
                baseImageData = {
                  filename: wikimediaData.filename,
                  title: wikimediaData.title,
                  year: imageInfo.year || wikimediaData.year,
                  source: wikimediaData.source,
                  description: imageInfo.description || wikimediaData.description || '',
                  revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
                };
              } else {
                 logger.warn(`Could not fetch wikimedia data for filename: ${filename}`);
              }
            } else {
               logger.warn(`Could not extract filename from wikimedia URL: ${imageInfo.url}`);
            }
          } else if (imageInfo.type === 'upload') {
            // Use uploadCounter to get the correct file from the uploadedFiles array
            if (uploadCounter < uploadedFiles.length) {
              const file = uploadedFiles[uploadCounter];
              originalJpegUrl = file.location; // S3 URL of the uploaded original
              s3Key = file.key; // Keep the S3 key
              filenameForPreviews = file.key; // Use S3 key for preview naming
              baseImageData = {
                filename: file.originalname, // Keep original filename
                title: file.originalname,
                year: imageInfo.year || new Date().getFullYear(),
                source: 'User Upload',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
              };
              uploadCounter++; // Increment for the next potential upload
            } else {
               logger.warn(`Upload type specified but no corresponding file found at index ${uploadCounter}`);
            }
          }

          // --- Start Image Processing ---
          let imageBuffer: Buffer | null = null;
          let generatedWebpUrl: string | null = null;

          if (originalJpegUrl) {
            try {
              logger.info(`Downloading original for processing: ${originalJpegUrl}`);
              imageBuffer = await downloadImage(originalJpegUrl);
              logger.info(`Downloaded ${imageBuffer.length} bytes for ${originalJpegUrl}`);
            } catch (downloadError) {
              logger.error(`Failed to download original image ${originalJpegUrl}:`, downloadError);
              // Image buffer remains null
            }
          } else {
            logger.warn(`Skipping download for image type ${imageInfo.type} as originalJpegUrl was null/undefined.`);
          }

          if (imageBuffer) {
            const baseKeyForPreviews = filenameForPreviews || `image_${Date.now()}`;
            logger.info(`Processing WebP for base key: ${baseKeyForPreviews}`);
            try {
              // Generate WebP (No resize, updated quality)
              try {
                logger.info(`Generating WebP...`);
                const webpBuffer = await sharp(imageBuffer)
                  .webp({ quality: 90 })
                  .toBuffer();
                logger.info(`Generated WebP buffer (${webpBuffer.length} bytes), uploading...`);
                generatedWebpUrl = await uploadProcessedToS3(webpBuffer, baseKeyForPreviews, 'webp');
                logger.info(`WebP uploaded to: ${generatedWebpUrl}`);
              } catch (webpError) {
                logger.error(`Failed to generate WebP for ${baseKeyForPreviews}:`, webpError);
                // generatedWebpUrl remains null
              }

            } catch (processingError) {
              logger.error(`General error processing image ${baseKeyForPreviews}:`, processingError);
              // WebP URL remains null
            }
          } else {
            logger.warn(`Skipping WebP generation for ${filenameForPreviews} because download failed or buffer was null.`);
          }
          // --- End Image Processing ---

          // Add to final list only if we have an original URL
          if (originalJpegUrl) {
            finalImageData.push({
              ...baseImageData,
              originalJpegUrl: originalJpegUrl,
              generatedWebpUrl: generatedWebpUrl,
            });
             logger.info(`Added image to final list: ${originalJpegUrl} (WebP: ${!!generatedWebpUrl})`);
          } else {
            logger.warn(`Not adding image to final list as originalJpegUrl was missing for type ${imageInfo.type}.`);
          }
        } // End of for...of imagesOrder loop
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

    // Ensure we have some images processed
    if (finalImageData.length === 0) {
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
        // Append processed images
        existingChallenge.images.push(...finalImageData);
      } else {
        // Replace with processed images
        existingChallenge.images = finalImageData;
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
      // Create new challenge with processed images
      const newChallenge = new DailyChallenge({
        date: challengeDate,
        images: finalImageData, // Use finalImageData here
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
        logger.info(`Processing ${orderData.length} images for edit`);
        const updatedImages: any[] = [];
        // Keep track of uploaded files used during edit
        let uploadCounter = 0; 
        
        // Process each image in the desired order
        for (const imageInfo of orderData) {
          logger.info(`Processing image for edit, type: ${imageInfo.type}`);
          
          if (imageInfo.type === 'existing') {
            // Handle existing image - mostly update metadata
            const index = parseInt(imageInfo.originalIndex, 10);
            if (!isNaN(index) && index >= 0 && index < challenge.images.length) {
              // Get existing image data, ensuring all fields (including previews) are copied
              // Manually create a plain JS object copy
              const currentImage = challenge.images[index];
              const existingImage = {
                filename: currentImage.filename,
                title: currentImage.title,
                originalJpegUrl: currentImage.originalJpegUrl,
                generatedWebpUrl: currentImage.generatedWebpUrl,
                year: currentImage.year,
                source: currentImage.source,
                description: currentImage.description,
                revealedDescription: currentImage.revealedDescription
              };
              
              // Update fields if provided in the request
              if (imageInfo.year !== undefined) {
                existingImage.year = parseInt(imageInfo.year, 10);
              }
              if (imageInfo.description !== undefined) {
                existingImage.description = imageInfo.description;
              }
              if (imageInfo.revealedDescription !== undefined) {
                existingImage.revealedDescription = imageInfo.revealedDescription;
              }
              
              logger.info(`Keeping existing image: ${existingImage.originalJpegUrl}`);
              updatedImages.push(existingImage);
            } else {
              logger.warn(`Invalid existing image index during edit: ${imageInfo.originalIndex}`);
            }
          } else if (imageInfo.type === 'wikimedia' || imageInfo.type === 'upload') {
            // Handle NEW Wikimedia or Uploaded image - same logic as CREATE
            let originalJpegUrl: string | null = null;
            let baseImageData: any = {};
            let s3Key: string | null = null;
            let filenameForPreviews: string | null = null;

            if (imageInfo.type === 'wikimedia') {
              const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : null;
              if (filename) {
                const wikimediaData = await fetchImageData(filename);
                if (wikimediaData) {
                  originalJpegUrl = wikimediaData.originalJpegUrl;
                  filenameForPreviews = filename;
                  baseImageData = {
                    filename: wikimediaData.filename,
                    title: wikimediaData.title,
                    year: imageInfo.year || wikimediaData.year,
                    source: wikimediaData.source,
                    description: imageInfo.description || wikimediaData.description || '',
                    revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
                  };
                } else { logger.warn(`Edit: Could not fetch wikimedia data for ${filename}`); }
              } else { logger.warn(`Edit: Could not extract filename from ${imageInfo.url}`); }
            } else { // type === 'upload'
               if (uploadCounter < uploadedFiles.length) {
                  const file = uploadedFiles[uploadCounter];
                  originalJpegUrl = (file as Express.MulterS3.File).location;
                  s3Key = (file as Express.MulterS3.File).key;
                  filenameForPreviews = s3Key; // Use S3 key
                  baseImageData = {
                    filename: file.originalname,
                    title: file.originalname,
                    year: imageInfo.year || new Date().getFullYear(),
                    source: 'User Upload',
                    description: imageInfo.description || '',
                    revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
                  };
                  uploadCounter++;
              } else { logger.warn(`Edit: Upload type specified but no file at index ${uploadCounter}`); }
            }

            // --- Start Image Processing (Same as Create, adjusted) ---
            let imageBuffer: Buffer | null = null;
            let generatedWebpUrl: string | null = null;

            if (originalJpegUrl) {
              try {
                logger.info(`Edit: Downloading original for processing: ${originalJpegUrl}`);
                imageBuffer = await downloadImage(originalJpegUrl);
                logger.info(`Edit: Downloaded ${imageBuffer?.length || 0} bytes for ${originalJpegUrl}`);
              } catch (downloadError) {
                logger.error(`Edit: Failed to download original image ${originalJpegUrl}:`, downloadError);
              }
            } else { logger.warn(`Edit: Skipping download for type ${imageInfo.type}, no originalJpegUrl.`); }

            if (imageBuffer) {
              const baseKeyForPreviews = filenameForPreviews || `image_${Date.now()}`;
              logger.info(`Edit: Processing WebP for base key: ${baseKeyForPreviews}`);
              try {
                // WebP (No resize, updated quality)
                try {
                  const webpBuffer = await sharp(imageBuffer)
                                          .webp({ quality: 90 })
                                          .toBuffer();
                  generatedWebpUrl = await uploadProcessedToS3(webpBuffer, baseKeyForPreviews, 'webp');
                  logger.info(`Edit: WebP uploaded: ${generatedWebpUrl}`);
                } catch (webpError) { logger.error(`Edit: Failed WebP for ${baseKeyForPreviews}:`, webpError); }
                
              } catch (processingError) { logger.error(`Edit: General processing error for ${baseKeyForPreviews}:`, processingError); }
            } else { logger.warn(`Edit: Skipping WebP generation for ${filenameForPreviews}, download failed.`); }
            // --- End Image Processing ---

            if (originalJpegUrl) {
              updatedImages.push({
                ...baseImageData,
                originalJpegUrl: originalJpegUrl,
                generatedWebpUrl: generatedWebpUrl,
              });
              logger.info(`Edit: Added new/uploaded image: ${originalJpegUrl} (WebP: ${!!generatedWebpUrl})`);
            } else { logger.warn(`Edit: Not adding image type ${imageInfo.type}, missing originalJpegUrl.`); }
            } else {
             logger.warn(`Unknown image type encountered during edit: ${imageInfo.type}`);
          }
        } // End of for...of orderData loop
        
        // Replace images only if we processed some valid ones
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

export default router;
