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
    const challengeDate = new Date(date);
    challengeDate.setUTCHours(0, 0, 0, 0);
    
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

export default router;
