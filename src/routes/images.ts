//images.ts (client)
import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Cache to minimize API calls to Wikimedia
const imageCache: any[] = [];

// Wikimedia API credentials
const clientId = process.env.WIKIMEDIA_CLIENT_ID;
const clientSecret = process.env.WIKIMEDIA_CLIENT_SECRET;
const accessToken = process.env.WIKIMEDIA_ACCESS_TOKEN;

// Fetch a random image from Wikimedia Commons with year information
async function getRandomImageWithYear(): Promise<any> {
  // Check if we have cached images
  if (imageCache.length > 0) {
    const randomIndex = Math.floor(Math.random() * imageCache.length);
    return imageCache[randomIndex];
  }

  try {
    // Fetch random images from Wikimedia API without auth headers
    const response = await fetch(
      'https://commons.wikimedia.org/w/api.php?action=query&list=random&rnnamespace=6&rnlimit=20&format=json',
      {
        headers: {
          'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
        }
      }
    );
  
    const data = await response.json();

if (!data.query || !data.query.random) {
  console.error('Unexpected API response:', data);
  throw new Error('Invalid response from Wikimedia API');
}
const randomImages = data.query.random;

    // Process each image to get more details and year information
    const processedImages = await Promise.all(
      randomImages.map(async (img: any) => {
        const title = img.title.replace('File:', '');
        
        // Get image info including upload date, URL, etc.
        const infoResponse = await fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(img.title)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata&format=json`,
          {
            headers: {
              'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
            }
          }
        );

        const infoData = await infoResponse.json();
        const pages = infoData.query.pages;
        const pageId = Object.keys(pages)[0];
        const imageInfo = pages[pageId].imageinfo[0];
        
        // Extract year from metadata or fallback to upload date
        let year;
        if (imageInfo.extmetadata && imageInfo.extmetadata.DateTimeOriginal) {
          const dateString = imageInfo.extmetadata.DateTimeOriginal.value;
          const yearMatch = dateString.match(/\b(18|19|20)\d{2}\b/);
          if (yearMatch) {
            year = parseInt(yearMatch[0]);
          }
        }
        
        // If we couldn't extract the year from metadata, try the upload date
        if (!year && imageInfo.timestamp) {
          year = new Date(imageInfo.timestamp).getFullYear();
        }
        
        // Only include images with a valid year
        if (year && year >= 1800 && year <= new Date().getFullYear()) {
          return {
            title,
            url: imageInfo.url,
            source: 'Wikimedia Commons',
            year
          };
        }
        
        return null;
      })
    );

    // Filter out null values and add to cache
    const validImages = processedImages.filter(img => img !== null);
    if (validImages.length > 0) {
      // Update cache with new images
      imageCache.push(...validImages);
      
      // Return a random one
      const randomIndex = Math.floor(Math.random() * validImages.length);
      return validImages[randomIndex];
    }
    
    // If no valid images found, retry
    return getRandomImageWithYear();
  } catch (error) {
    console.error('Error fetching image from Wikimedia:', error);
    throw error;
  }
}

// Route to get a random image with year information
router.get('/', async (_req: Request, res: Response) => {
  try {
    const image = await getRandomImageWithYear();
    res.json(image);
  } catch (error) {
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

export default router;