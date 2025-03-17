// src/routes/admin.ts
import express, { Request, Response, RequestHandler } from 'express';
import path from 'path';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData, extractFilenameFromUrl } from '../utils/wikimediaHelper';
import logger from '../utils/logger';

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
  // Create a new date to avoid modifying the original
  const ctDate = new Date(date);
  
  // Get the UTC offset for US Central Time (CT)
  // This accounts for Daylight Saving Time automatically
  const ctOffset = -6 * 60; // -6 hours in minutes for CST, or -5 for CDT
  const now = new Date();
  const isDST = (): boolean => {
    // Simple DST detection for US Central Time
    // DST starts on second Sunday in March and ends on first Sunday in November
    const jan = new Date(now.getFullYear(), 0, 1);
    const jul = new Date(now.getFullYear(), 6, 1);
    const stdTimezoneOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
    return now.getTimezoneOffset() < stdTimezoneOffset;
  };
  
  // Adjust offset for DST if needed
  const offset = isDST() ? ctOffset + 60 : ctOffset; // +60 minutes during DST
  
  // Set to local midnight in CT
  ctDate.setUTCHours(0, 0, 0, 0);
  // Adjust for CT offset (converting UTC midnight to CT midnight)
  ctDate.setMinutes(ctDate.getMinutes() - offset);
  
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
router.post('/daily-challenge/create', verifyAdmin, (async (req, res) => {
  try {
    const { date, imageUrl, imageUrls } = req.body;
    
    if (!date) {
      return res.status(400).json({ error: 'Date is required' });
    }
    
    // Parse date and reset to UTC midnight
    const challengeDate = setCentralTimeMidnight(new Date(date));
    
    if (isNaN(challengeDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    // Handle multiple URLs or a single URL
    let filenames: string[] = [];
    
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      for (const url of imageUrls) {
        const filename = extractFilenameFromUrl(url);
        if (filename) {
          filenames.push(filename);
        }
      }
    } else if (imageUrl) {
      const filename = extractFilenameFromUrl(imageUrl);
      if (filename) {
        filenames.push(filename);
      }
    }
    
    if (filenames.length === 0) {
      return res.status(400).json({ error: 'No valid Wikimedia URLs provided' });
    }
    
    // Check if a challenge already exists for this date
    const existingChallenge = await DailyChallenge.findOne({
      date: { 
        $gte: challengeDate,
        $lt: new Date(challengeDate.getTime() + 24 * 60 * 60 * 1000)
      }
    });
    
    // Fetch image data for all filenames
    const imageData = await fetchMultipleImageData(filenames);
    
    if (imageData.length === 0) {
      return res.status(400).json({ error: 'Failed to fetch image data' });
    }
    
    if (existingChallenge) {
      // Update existing challenge with new images; support append mode
      if (req.query.append === 'true') {
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
    logger.error('Error creating daily challenge:', error);
    res.status(500).json({ error: 'Failed to create daily challenge' });
  }
}) as RequestHandler);

/**
 * GET /admin/daily-challenges
 * List all daily challenges
 * 
 * Updated to return an array directly so that challenges.map can be used on the frontend.
 */
router.get('/daily-challenges', verifyAdmin, async (req: Request, res: Response) => {
  try {
    const challenges = await DailyChallenge.find().sort({ date: -1 });
    res.status(200).json(challenges);
  } catch (error) {
    logger.error('Error fetching daily challenges:', error);
    res.status(500).json({ error: 'Failed to fetch daily challenges' });
  }
});

/**
 * Edit a daily challenge
 * PUT /admin/daily-challenge/:id/edit
 */
router.put('/daily-challenge/:id/edit', verifyAdmin, (async (req, res) => {
  try {
    const { id } = req.params;
    const { date, keepImages, newImageUrls, imageUpdates } = req.body;

    // Find the challenge
    const challenge = await DailyChallenge.findById(id);
    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }

    // Update date if provided
    if (date) {
      challenge.date = setCentralTimeMidnight(new Date(date));
    }

    // Filter images to keep
    if (Array.isArray(keepImages) && keepImages.length > 0) {
      challenge.images = keepImages.map(index => challenge.images[index]);
    }

    // Apply updates to image metadata if provided
    if (imageUpdates && typeof imageUpdates === 'object') {
      Object.keys(imageUpdates).forEach(index => {
        const idx = parseInt(index, 10);
        if (!isNaN(idx) && idx >= 0 && idx < challenge.images.length) {
          const updates = imageUpdates[index];
          
          // Update year if provided
          if (updates.year !== undefined) {
            const year = parseInt(updates.year, 10);
            if (!isNaN(year)) {
              challenge.images[idx].year = year;
            }
          }
          
          // Update description if provided
          if (updates.description !== undefined) {
            challenge.images[idx].description = updates.description;
          }
        }
      });
    }

    // Add new images if provided
    if (Array.isArray(newImageUrls) && newImageUrls.length > 0) {
      let newFilenames: string[] = [];
      
      for (const url of newImageUrls) {
        const filename = extractFilenameFromUrl(url);
        if (filename) {
          newFilenames.push(filename);
        }
      }
      
      if (newFilenames.length > 0) {
        const newImageData = await fetchMultipleImageData(newFilenames);
        challenge.images = [...challenge.images, ...newImageData];
      }
    }

    // Save updated challenge
    await challenge.save();
    
    res.status(200).json({ 
      message: 'Challenge updated successfully',
      challenge
    });
  } catch (error) {
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
