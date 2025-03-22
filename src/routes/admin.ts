// src/routes/admin.ts
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData, extractFilenameFromUrl } from '../utils/wikimediaHelper';
import logger from '../utils/logger';
import multer from 'multer'; 
import fs from 'fs';

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Use process.cwd() to get the root of the project consistently
    const uploadDir = path.resolve(process.cwd(), 'uploads');
    console.log('Saving uploaded file to:', uploadDir);
    
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate a unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const filename = file.fieldname + '-' + uniqueSuffix + ext;
    console.log('Generated filename:', filename);
    cb(null, filename);
  }
});

// File filter to only accept images
const fileFilter = (
  req: Express.Request, 
  file: Express.Multer.File, 
  cb: multer.FileFilterCallback
) => {
  if (file.mimetype.startsWith('image/')) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed!') as any, false);
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
  
  // If it's an uploaded image URL
  if (url.includes('uploads')) {
    // Extract the filename
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    // Recreate with consistent format
    return `/uploads/${filename}`;
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

function setCentralTimeMidnight(date: Date): Date {
  // First convert the date to a string in Central Time
  const ctDateStr = date.toLocaleString('en-US', { timeZone: 'America/Chicago' });
  
  // Parse the CT date string back to a Date object
  const ctDate = new Date(ctDateStr);
  
  // Set to midnight
  ctDate.setHours(0, 0, 0, 0);
  
  return ctDate;
}

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
    const { date } = req.body;
    
    if (!date) {
      // Delete uploaded files if there's an error
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
      return res.status(400).json({ error: 'Date is required' });
    }
    
    // Parse date and reset to Central Time midnight
    const challengeDate = setCentralTimeMidnight(new Date(date));
    
    if (isNaN(challengeDate.getTime())) {
      // Delete uploaded files if there's an error
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    // Process imagesOrder from the request
    let imageData: any[] = [];
    
    if (req.body.imagesOrder) {
      const imagesOrder = JSON.parse(req.body.imagesOrder);
      const uploadedFiles = req.files as Express.Multer.File[] || [];
      
      for (const imageInfo of imagesOrder) {
        if (imageInfo.type === 'wikimedia') {
          // Handle Wikimedia images
          const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : '';
          
          // Only proceed if we have a valid filename
          if (filename) {
            const wikimediaData = await fetchImageData(filename);
            
            if (wikimediaData) {
              // Add the custom fields from the form
              wikimediaData.year = imageInfo.year || wikimediaData.year;
              wikimediaData.description = imageInfo.description || wikimediaData.description || '';
              wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
              
              imageData.push(wikimediaData);
            }
          }
        } else if (imageInfo.type === 'upload') {
          // Handle uploaded files
          const uploadIndex = imageInfo.uploadIndex;
          
          if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
            const file = uploadedFiles[uploadIndex];
            
            // Create an image object for this uploaded file
            const fileUrl = `/uploads/${path.basename(file.path)}`;
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
    }
    
    // Ensure we have some images
    if (imageData.length === 0) {
      // Delete uploaded files if there's an error
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
      return res.status(400).json({ error: 'No valid images provided' });
    }
    
    // Check for append mode
    const appendImages = req.body.append === 'true';
    
    // Check if a challenge already exists for this date
    const existingChallenge = await DailyChallenge.findOne({
      date: { 
        $gte: challengeDate,
        $lt: new Date(challengeDate.getTime() + 24 * 60 * 60 * 1000)
      }
    });
    
    if (existingChallenge) {
      // Update existing challenge with new images
      if (appendImages) {
        existingChallenge.images = [...existingChallenge.images, ...imageData];
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
    }
    
    // Create new challenge
    const newChallenge = new DailyChallenge({
      date: challengeDate,
      images: imageData,
      stats: {
        averageScore: 0,
        completions: 0,
        distributions: []
      },
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
  } catch (error) {
    // Delete uploaded files if there's an error
    if (req.files && Array.isArray(req.files)) {
      req.files.forEach(file => {
        fs.unlinkSync(file.path);
      });
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
router.put('/daily-challenge/:id/edit', verifyAdmin, upload.array('uploadedFiles', 5), (async (req, res, next) => {
  try {
    const { id } = req.params;
    const { date, imagesOrder } = req.body;
    
    console.log(`Editing challenge ${id}`);
    const uploadedFiles = req.files as Express.Multer.File[] || [];
    console.log(`Received ${uploadedFiles.length} uploaded files`);
    uploadedFiles.forEach((file, index) => {
      console.log(`File ${index}: ${file.originalname}, size: ${file.size}, path: ${file.path}`);
    });
    console.log(`Received ${req.files?.length || 0} uploaded files`);
    
    console.log(`Editing challenge ${id}`);
    
    // Find the challenge
    const challenge = await DailyChallenge.findById(id);
    if (!challenge) {
      // Handle error case
      return res.status(404).json({ error: 'Challenge not found' });
    }

    // Update date if provided
    if (date) {
      challenge.date = setCentralTimeMidnight(new Date(date));
    }

    // Log existing images for debugging
    console.log('Existing images before update:');
    challenge.images.forEach((img, i) => {
      console.log(`[${i}] ${img.url} (${img.source || 'Unknown'})`);
    });

    // Process image updates if provided
    if (imagesOrder) {
      try {
        const orderData = typeof imagesOrder === 'string' ? JSON.parse(imagesOrder) : imagesOrder;
        const uploadedFiles = req.files as Express.Multer.File[] || [];
        
        console.log(`Processing ${orderData.length} images from imagesOrder`);
        console.log(`Received ${uploadedFiles.length} new uploaded files`);
        
        const updatedImages: any[] = [];
        
        // Process each image
        for (const imageInfo of orderData) {
          console.log(`Processing image of type: ${imageInfo.type}`);
          
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
              
              console.log(`Adding existing image: ${existingImage.url}`);
              updatedImages.push(existingImage);
            }
          } else if (imageInfo.type === 'wikimedia') {
            // Handle Wikimedia image (existing code)
            const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : '';
            if (filename) {
              const wikimediaData = await fetchImageData(filename);
              if (wikimediaData) {
                wikimediaData.year = imageInfo.year || wikimediaData.year;
                wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                
                console.log(`Adding Wikimedia image: ${wikimediaData.url}`);
                updatedImages.push(wikimediaData);
              }
            }
          } else if (imageInfo.type === 'upload') {
            // Handle new upload
            const uploadIndex = parseInt(imageInfo.uploadIndex, 10);
            console.log(`Processing upload index: ${uploadIndex} (of ${uploadedFiles.length} files)`);
            
            if (!isNaN(uploadIndex) && uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex];
              console.log(`Found uploaded file: ${file.originalname} at path ${file.path}`);
              
              // Create proper URL with leading slash
              const fileName = path.basename(file.path);
              const fileUrl = `/uploads/${fileName}`;
              
              console.log(`Created URL for uploaded file: ${fileUrl}`);
              
              updatedImages.push({
                filename: file.originalname,
                title: file.originalname || 'Uploaded image',
                url: fileUrl,
                year: imageInfo.year ? parseInt(imageInfo.year, 10) : new Date().getFullYear(),
                source: 'User Upload',
                description: imageInfo.description || '',
                revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
              });
              
              console.log(`Added uploaded image: ${fileUrl}`);
            }
          }
        }
        
        // Replace images if we have new ones
        if (updatedImages.length > 0) {
          console.log(`Replacing challenge images with ${updatedImages.length} updated images`);
          challenge.images = updatedImages;
        }
      } catch (error) {
        console.error('Error processing image updates:', error);
        return res.status(400).json({ error: 'Invalid image order data' });
      }
    }

    // Log images before saving
    console.log('Images to be saved:');
    challenge.images.forEach((img, i) => {
      console.log(`[${i}] ${img.url} (${img.source || 'Unknown'})`);
    });

    // Save the updated challenge
    await challenge.save();
    
    console.log(`Challenge ${id} updated successfully with ${challenge.images.length} images`);
    
    res.status(200).json({ 
      message: 'Challenge updated successfully',
      challenge: {
        id: challenge._id,
        date: challenge.date,
        imageCount: challenge.images.length
      }
    });
  } catch (error) {
    console.error('Error updating challenge:', error);
    
    // Clean up uploaded files on error
    if (req.files && Array.isArray(req.files)) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (e) {
          console.error(`Failed to delete file ${file.path}:`, e);
        }
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to update daily challenge', 

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
