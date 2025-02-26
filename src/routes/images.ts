import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import { 
  WikimediaImage, 
  WikimediaQueryResponse, 
  ImageCache 
} from '../types/wikimedia';

const router = express.Router();

// Environment variables
const ACCESS_TOKEN = process.env.WIKIMEDIA_ACCESS_TOKEN as string;

// Cache constants
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const MAX_CACHE_SIZE = 100;

// Cache to minimize API requests
const imageCache: ImageCache = {
  items: [],
  lastUpdate: null
};

// Add to routes/images.ts

// Function to get or fetch images with caching
// Function to get or fetch images with caching
async function getOrFetchRandomImages(): Promise<WikimediaImage[]> {
    // Check if cache is valid
    const now = Date.now();
    if (imageCache.items.length > 0 && imageCache.lastUpdate && 
        (now - imageCache.lastUpdate < CACHE_DURATION)) {
      return imageCache.items;
    }
    
    // Implementation for fetching a batch of images to cache
    const apiUrl = 'https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:Featured_pictures&gcmlimit=20&prop=imageinfo&iiprop=url|extmetadata&format=json';
    
    const response = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`API request failed with status ${response.status}`);
    }
    
    const data = await response.json() as WikimediaQueryResponse;
    
    // Process and filter images with valid dates
    const validImages: WikimediaImage[] = [];
    
    if (data.query && data.query.pages) {
      const pages = data.query.pages;
      
      for (const pageId in pages) {
        const page = pages[pageId];
        if (!page.imageinfo || !page.imageinfo[0]) continue;
        
        const imageInfo = page.imageinfo[0];
        const metadata = imageInfo.extmetadata;
        
        if (!metadata) continue;
        
        // Try to extract year from different metadata fields
        const dateFields = ['DateTimeOriginal', 'DateTime', 'date'];
        let validYear: number | null = null;
        
        for (const field of dateFields) {
          if (metadata[field] && metadata[field]?.value) {
            const dateString = metadata[field]?.value || '';
            const yearMatch = dateString.match(/\b(18|19|20)\d{2}\b/);
            if (yearMatch) {
              validYear = parseInt(yearMatch[0], 10);
              break;
            }
          }
        }
        
        // If we found a valid year, use this image
        if (validYear && validYear <= new Date().getFullYear()) {
          validImages.push({
            title: page.title.replace('File:', ''),
            url: imageInfo.url,
            year: validYear,
            source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`
          });
        }
      }
    }
    
    // Update cache
    imageCache.items = validImages;
    imageCache.lastUpdate = now;
    
    return validImages;
  }
  
  // Modified endpoint to use cache
  router.get('/random', async (req: Request, res: Response) => {
    try {
      // Get images from cache or fetch new ones
      const images = await getOrFetchRandomImages();
      
      if (images.length === 0) {
        return res.status(404).json({ error: 'No images found' });
      }
      
      // Return a random image from the available images
      const randomIndex = Math.floor(Math.random() * images.length);
      return res.json(images[randomIndex]);
      
    } catch (error) {
      console.error('Error fetching random image:', error);
      res.status(500).json({ error: 'Failed to fetch image from Wikimedia' });
    }
  });

export default router;