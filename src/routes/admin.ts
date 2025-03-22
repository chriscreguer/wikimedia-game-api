// src/routes/admin.ts
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData, extractFilenameFromUrl } from '../utils/wikimediaHelper';
import logger from '../utils/logger';
import multer from 'multer'; 
import fs from 'fs';

const storage = multer.diskStorage({
  destination: function (
    req: Express.Request, 
    file: Express.Multer.File, 
    cb: (error: Error | null, destination: string) => void
  ) {
    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (
    req: Express.Request, 
    file: Express.Multer.File, 
    cb: (error: Error | null, filename: string) => void
  ) {
    // Generate a unique filename
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
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

function setCentralTimeMidnight(date: Date): Date {
  // Get the ISO date string (YYYY-MM-DD)
  const isoDate = date.toISOString().split('T')[0];
  
  // Create a new date at midnight UTC using the ISO date
  const utcMidnight = new Date(`${isoDate}T00:00:00Z`);
  
  // Since we want Central Time, add the timezone offset (6 hours for CST)
  const centralTimeOffset = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
  const centralMidnight = new Date(utcMidnight.getTime() + centralTimeOffset);
  
  return centralMidnight;
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

router.get('/daily-challenges', verifyAdmin, async (req: Request, res: Response) => {
  try {
    const challenges = await DailyChallenge.find().sort({ date: -1 });
    
    // Map to plain objects that can be sent to the client
    const formattedChallenges = challenges.map(challenge => {
      // Convert to plain object
      const plainObj = challenge.toObject();
      
      // Create a new object with all the properties we need
      return {
        ...plainObj,
        // Add the formatted date
        formattedDate: challenge.date.toISOString().split('T')[0],
        // Ensure image URLs are consistent
        images: plainObj.images?.map((img: any) => ({
          ...img,
          url: img.url && img.url.includes('uploads/') 
            ? '/' + img.url.replace(/^\/+/, '') 
            : img.url
        }))
      };
    });
    
    res.status(200).json(formattedChallenges);
  } catch (error) {
    logger.error('Error fetching daily challenges:', error);
    res.status(500).json({ error: 'Failed to fetch daily challenges' });
  }
});

/**
 * Edit a daily challenge
 * PUT /admin/daily-challenge/:id/edit
 */
router.put('/daily-challenge/:id/edit', verifyAdmin, upload.array('uploadedFiles', 5), (async (req, res) => {
  try {
    const { id } = req.params;
    const { date, imagesOrder } = req.body;

    // Find the challenge
    const challenge = await DailyChallenge.findById(id);
    if (!challenge) {
      // Delete uploaded files if there's an error
      if (req.files && Array.isArray(req.files)) {
        req.files.forEach(file => {
          fs.unlinkSync(file.path);
        });
      }
      return res.status(404).json({ error: 'Challenge not found' });
    }

    // Update date if provided
    if (date) {
      challenge.date = setCentralTimeMidnight(new Date(date));
    }

    // Process image updates if provided
    if (imagesOrder) {
      try {
        const orderData = JSON.parse(imagesOrder);
        const uploadedFiles = req.files as Express.Multer.File[] || [];
        const updatedImages: any[] = [];
        
        // Process each image in the order specified
        for (const imageInfo of orderData) {
          if (imageInfo.type === 'existing') {
            // Keep existing image with updates
            const index = parseInt(imageInfo.originalIndex, 10);
            if (!isNaN(index) && index >= 0 && index < challenge.images.length) {
              const existingImage = { ...challenge.images[index] };
              
              // Update specific fields
              if (imageInfo.year !== undefined) {
                existingImage.year = parseInt(imageInfo.year, 10);
              }
              
              if (imageInfo.description !== undefined) {
                existingImage.description = imageInfo.description;
              }
              
              if (imageInfo.revealedDescription !== undefined) {
                existingImage.revealedDescription = imageInfo.revealedDescription;
              }
              
              updatedImages.push(existingImage);
            }
          } else if (imageInfo.type === 'wikimedia') {
            // Add new Wikimedia image
            const filename = imageInfo.url ? extractFilenameFromUrl(imageInfo.url) : '';
            
            // Only proceed if we have a valid filename
            if (filename) {
              const wikimediaData = await fetchImageData(filename);
              
              if (wikimediaData) {
                // Add custom fields from the form
                wikimediaData.year = imageInfo.year || wikimediaData.year;
                wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                
                updatedImages.push(wikimediaData);
              }
            }
          } else if (imageInfo.type === 'upload') {
            // Add new uploaded file
            const uploadIndex = imageInfo.uploadIndex;
            
            if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
              const file = uploadedFiles[uploadIndex];
              
              // Create image object for this upload
              const fileUrl = `/uploads/${path.basename(file.path)}`;
              updatedImages.push({
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
        
        // Replace images array with the updated one
        if (updatedImages.length > 0) {
          challenge.images = updatedImages;
        }
      } catch (error) {
        console.error('Error processing image updates:', error);
        return res.status(400).json({ error: 'Invalid image order data' });
      }
    }

    // Save updated challenge
    await challenge.save();
    
    res.status(200).json({ 
      message: 'Challenge updated successfully',
      challenge: {
        id: challenge._id,
        date: challenge.date,
        imageCount: challenge.images.length
      }
    });
  } catch (error) {
    // Delete uploaded files if there's an error
    if (req.files && Array.isArray(req.files)) {
      req.files.forEach(file => {
        fs.unlinkSync(file.path);
      });
    }
    
    logger.error('Error updating daily challenge:', error);
    res.status(500).json({ error: 'Failed to update daily challenge' });
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
