import express, { Request, Response } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Cache expiration time
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100;
const MIN_YEAR = 1800; // Minimum year allowed for images

// Get current year for max year limit
const CURRENT_YEAR = new Date().getFullYear();

// Decade ranges to ensure even distribution
const DECADE_RANGES = [
  { start: 1800, end: 1849 },
  { start: 1850, end: 1899 },
  { start: 1900, end: 1919 },
  { start: 1920, end: 1939 },
  { start: 1940, end: 1959 },
  { start: 1960, end: 1979 },
  { start: 1980, end: 1999 },
  { start: 2000, end: CURRENT_YEAR }
];

interface CachedImage {
  title: string;
  url: string;
  source: string;
  year: number;
  cachedAt: number;
  category?: string;
  description?: string; 
  filename?: string;   
}

// Cache to minimize API calls to Wikimedia, organized by decade
const imageCacheByDecade: Record<string, CachedImage[]> = {};

// STRICTLY photo-only file extensions
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png'];

// Categories focused specifically on photographs
const photoCategories = [
  'Category:Photographs_by_decade',
  'Category:Historical_photographs',
  'Category:Portrait_photographs',
  'Category:Documentary_photographs',
  'Category:Photojournalism',
  'Category:Landscape_photographs',
  'Category:Architecture_photographs',
  'Category:Wildlife_photography',
  'Category:Street_photography'
];

// Maximum number of API retries
const MAX_RETRIES = 3;
const IMAGES_PER_REQUEST = 50;

// Helper function to check if a file is a photograph by its extension
function isPhotoFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some(ext => lowerFilename.endsWith(ext));
}

// Helper function to determine if metadata indicates a real photograph
function isLikelyRealPhoto(metadata: any): boolean {
  if (!metadata) return false;
  
  // Check for camera information (strong indicators)
  if (metadata.Artist || metadata.Make || metadata.Model) return true;
  
  // Check for photo-specific categories
  if (metadata.Categories) {
    const categories = metadata.Categories.value || '';
    const photoKeywords = ['photograph', 'photo', 'portrait', 'camera'];
    const negativeKeywords = ['drawing', 'illustration', 'clipart', 'diagram', 'logo', 'map', 'chart'];
    
    if (photoKeywords.some(keyword => categories.toLowerCase().includes(keyword)) &&
        !negativeKeywords.some(keyword => categories.toLowerCase().includes(keyword))) {
      return true;
    }
  }
  
  // Check for description suggesting it's a photograph
  if (metadata.ImageDescription) {
    const description = metadata.ImageDescription.value || '';
    const photoKeywords = ['photograph', 'photo', 'taken', 'camera', 'picture'];
    const negativeKeywords = ['drawing', 'illustration', 'clipart', 'diagram', 'logo', 'map', 'chart'];
    
    if (photoKeywords.some(keyword => description.toLowerCase().includes(keyword)) &&
        !negativeKeywords.some(keyword => description.toLowerCase().includes(keyword))) {
      return true;
    }
  }
  
  return false;
}

// Function to extract year from metadata with higher confidence
function extractYearWithConfidence(metadata: any, uploadYear: number): { year: number, confidence: 'high' | 'medium' | 'low' } {
  if (!metadata) return { year: uploadYear, confidence: 'low' };
  
  // Try to get year from DateTimeOriginal with highest confidence
  if (metadata.DateTimeOriginal) {
    const dateString = metadata.DateTimeOriginal.value;
    // Match a year between 1800 and current year
    const yearMatch = dateString.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0]);
      if (year >= MIN_YEAR && year <= CURRENT_YEAR) {
        return { year, confidence: 'high' };
      }
    }
  }
  
  // Try other date fields with medium confidence
  const dateFields = ['DateTime', 'DateTimeDigitized', 'MetadataDate'];
  for (const field of dateFields) {
    if (metadata[field]) {
      const dateString = metadata[field].value;
      const yearMatch = dateString.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
      if (yearMatch) {
        const year = parseInt(yearMatch[0]);
        if (year >= MIN_YEAR && year <= CURRENT_YEAR) {
          return { year, confidence: 'medium' };
        }
      }
    }
  }
  
  // Look for year in title or description with medium confidence
  if (metadata.ObjectName || metadata.ImageDescription) {
    const textToSearch = (metadata.ObjectName?.value || '') + ' ' + (metadata.ImageDescription?.value || '');
    const yearMatches = textToSearch.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/g);
    
    if (yearMatches && yearMatches.length > 0) {
      // If same year appears multiple times, it's more likely to be correct
      const yearCounts = new Map<number, number>();
      yearMatches.forEach(match => {
        const year = parseInt(match);
        if (year >= MIN_YEAR && year <= CURRENT_YEAR) {
          yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
        }
      });
      
      if (yearCounts.size > 0) {
        // Find the year that appears most frequently
        let maxYear = MIN_YEAR;
        let maxCount = 0;
        
        for (const [year, count] of yearCounts.entries()) {
          if (count > maxCount) {
            maxYear = year;
            maxCount = count;
          }
        }
        
        return { year: maxYear, confidence: 'medium' };
      }
    }
  }
  
  // Use upload year as last resort with low confidence
  if (uploadYear >= MIN_YEAR && uploadYear <= CURRENT_YEAR) {
    return { year: uploadYear, confidence: 'low' };
  }
  
  // If all else fails but we need a year within our range
  return { year: Math.floor(Math.random() * (CURRENT_YEAR - MIN_YEAR + 1)) + MIN_YEAR, confidence: 'low' };
}

// Function to fetch images from a specific category
async function getImagesFromCategory(category: string, decadeRange: { start: number, end: number }): Promise<CachedImage[]> {
  try {
    const response = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(category)}&cmlimit=${IMAGES_PER_REQUEST}&cmtype=file&format=json`,
      {
        headers: {
          'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
        }
      }
    );
    
    const data = await response.json();
    if (!data.query || !data.query.categorymembers) {
      return [];
    }
    
    const files = data.query.categorymembers;
    
    // Get details for each file
    const processedImages = await Promise.all(
      files.map(async (file: any) => {
        const title = file.title.replace('File:', '');
        
        // Skip if not a photo file (strict check)
        if (!isPhotoFile(title)) {
          return null;
        }
        
        // Additional check for video/audio extensions that should be excluded
        const lowerTitle = title.toLowerCase();
        if (lowerTitle.endsWith('.mp4') || 
            lowerTitle.endsWith('.webm') || 
            lowerTitle.endsWith('.ogv') || 
            lowerTitle.endsWith('.avi') || 
            lowerTitle.endsWith('.mov') || 
            lowerTitle.endsWith('.mpg') || 
            lowerTitle.endsWith('.mpeg') || 
            lowerTitle.endsWith('.mp3') || 
            lowerTitle.endsWith('.ogg')) {
          return null;
        }
        
        // Get image info including upload date, URL, etc.
        const infoResponse = await fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(file.title)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`,
          {
            headers: {
              'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
            }
          }
        );

        const infoData = await infoResponse.json();
        const pages = infoData.query.pages;
        const pageId = Object.keys(pages)[0];
        
        if (!pages[pageId].imageinfo || !pages[pageId].imageinfo[0]) {
          return null;
        }
        
        const imageInfo = pages[pageId].imageinfo[0];
        
        // Triple-check: verify it's an image type by checking mime type too
        if (imageInfo.mime && !imageInfo.mime.startsWith('image/')) {
          return null;
        }
        
        // Verify it's a bitmap image, not another type
        if (imageInfo.mediatype && imageInfo.mediatype !== 'BITMAP') {
          return null;
        }
        
        // Check for real photo indications - be more strict here
        if (!isLikelyRealPhoto(imageInfo.extmetadata)) {
          return null;
        }
        
        // Extract upload year as fallback
        const uploadYear = new Date(imageInfo.timestamp).getFullYear();
        
        // Get year with confidence level
        const { year, confidence } = extractYearWithConfidence(
          imageInfo.extmetadata, 
          uploadYear
        );
        
        // Skip if confidence is low or year isn't in our target decade range
        if (confidence === 'low' || year < decadeRange.start || year > decadeRange.end) {
          return null;
        }
        
        return {
          title,
          url: imageInfo.url,
          source: 'Wikimedia Commons',
          year,
          cachedAt: Date.now(),
          category,
          description: imageInfo.extmetadata?.ImageDescription?.value || '',
          filename: title
        };
      })
    );
    
    return processedImages.filter(img => img !== null) as CachedImage[];
  } catch (error) {
    console.error(`Error fetching from category ${category}:`, error);
    return [];
  }
}

// Function to get random decade range with balanced distribution
function getRandomDecadeRange(): { start: number, end: number } {
  return DECADE_RANGES[Math.floor(Math.random() * DECADE_RANGES.length)];
}

// Function to fetch random images directly
async function getRandomWikimediaImages(decadeRange: { start: number, end: number }): Promise<CachedImage[]> {
  try {
    // Fetch random images from Wikimedia API
    const response = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&list=random&rnnamespace=6&rnlimit=${IMAGES_PER_REQUEST}&format=json`,
      {
        headers: {
          'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
        }
      }
    );
  
    const data = await response.json();

    if (!data.query || !data.query.random) {
      console.error('Unexpected API response:', data);
      return [];
    }
    const randomImages = data.query.random;

    // Process each image to get more details and year information
    const processedImages = await Promise.all(
      randomImages.map(async (img: any) => {
        const title = img.title.replace('File:', '');
        
        // Skip if not a photo file
        if (!isPhotoFile(title)) {
          return null;
        }
        
        // Get image info including upload date, URL, etc.
        const infoResponse = await fetch(
          `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(img.title)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`,
          {
            headers: {
              'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
            }
          }
        );

        const infoData = await infoResponse.json();
        const pages = infoData.query.pages;
        const pageId = Object.keys(pages)[0];
        
        if (!pages[pageId].imageinfo || !pages[pageId].imageinfo[0]) {
          return null;
        }
        
        const imageInfo = pages[pageId].imageinfo[0];
        
        // Verify it's an image type by checking mime type
        if (imageInfo.mime && !imageInfo.mime.startsWith('image/')) {
          return null;
        }
        
        // Verify it's a bitmap image
        if (imageInfo.mediatype && imageInfo.mediatype !== 'BITMAP') {
          return null;
        }
        
        // Check for real photo indications
        if (!isLikelyRealPhoto(imageInfo.extmetadata)) {
          return null;
        }
        
        // Extract upload year as fallback
        const uploadYear = new Date(imageInfo.timestamp).getFullYear();
        
        // Get year with confidence level
        const { year, confidence } = extractYearWithConfidence(
          imageInfo.extmetadata, 
          uploadYear
        );
        
        // Skip if confidence is low or year isn't in our target decade range
        if (confidence === 'low' || year < decadeRange.start || year > decadeRange.end) {
          return null;
        }
        
        return {
          title,
          url: imageInfo.url,
          source: 'Wikimedia Commons',
          year,
          cachedAt: Date.now(),
          description: imageInfo.extmetadata?.ImageDescription?.value || '',
          filename: title
        };
      })
    );

    return processedImages.filter(img => img !== null) as CachedImage[];
  } catch (error) {
    console.error('Error fetching images from Wikimedia:', error);
    return [];
  }
}

// Fetch a random image with year information, targeting specific decade
// With retry mechanism to ensure we always return an image
async function getRandomImageWithYear(targetDecade?: { start: number, end: number }): Promise<CachedImage> {
  // Clean expired cache entries for all decades
  const now = Date.now();
  Object.keys(imageCacheByDecade).forEach(decade => {
    imageCacheByDecade[decade] = imageCacheByDecade[decade].filter(img => (now - img.cachedAt) < CACHE_EXPIRY_MS);
  });
  
  // If no target decade specified, choose one randomly
  const decadeRange = targetDecade || getRandomDecadeRange();
  const decadeKey = `${decadeRange.start}-${decadeRange.end}`;
  
  // Initialize cache for this decade if needed
  if (!imageCacheByDecade[decadeKey]) {
    imageCacheByDecade[decadeKey] = [];
  }
  
  // Use cache only if it has enough images for this decade
  if (imageCacheByDecade[decadeKey].length > 3) {
    const randomIndex = Math.floor(Math.random() * imageCacheByDecade[decadeKey].length);
    return imageCacheByDecade[decadeKey][randomIndex];
  }

  // First, try with category-based approach
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Select a random category
      const randomCategory = photoCategories[Math.floor(Math.random() * photoCategories.length)];
      
      // Get images from this category for the specified decade
      const images = await getImagesFromCategory(randomCategory, decadeRange);
      
      if (images.length > 0) {
        // Update cache for this decade
        imageCacheByDecade[decadeKey].push(...images);
        
        // Limit cache size for this decade
        if (imageCacheByDecade[decadeKey].length > MAX_CACHE_SIZE / DECADE_RANGES.length) {
          imageCacheByDecade[decadeKey].splice(0, imageCacheByDecade[decadeKey].length - (MAX_CACHE_SIZE / DECADE_RANGES.length));
        }
        
        // Return a random image
        const randomIndex = Math.floor(Math.random() * images.length);
        return images[randomIndex];
      }
      
      console.log(`Attempt ${attempt + 1}: No images found in category ${randomCategory} for decade ${decadeKey}`);
    } catch (error) {
      console.error(`Attempt ${attempt + 1} failed:`, error);
    }
  }
  
  // If category approach fails, try with direct random approach
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Get random images
      const images = await getRandomWikimediaImages(decadeRange);
      
      if (images.length > 0) {
        // Update cache for this decade
        imageCacheByDecade[decadeKey].push(...images);
        
        // Limit cache size
        if (imageCacheByDecade[decadeKey].length > MAX_CACHE_SIZE / DECADE_RANGES.length) {
          imageCacheByDecade[decadeKey].splice(0, imageCacheByDecade[decadeKey].length - (MAX_CACHE_SIZE / DECADE_RANGES.length));
        }
        
        // Return a random image
        const randomIndex = Math.floor(Math.random() * images.length);
        return images[randomIndex];
      }
      
      console.log(`Random attempt ${attempt + 1}: No images found for decade ${decadeKey}`);
    } catch (error) {
      console.error(`Random attempt ${attempt + 1} failed:`, error);
    }
  }
  
  // If we still have no images, try with a different decade
  if (targetDecade) {
    console.log(`Failed to find images for decade ${decadeKey}, trying any decade`);
    return getRandomImageWithYear();
  }
  
  // Final fallback: if all else fails, generate a simple image with the decade range
  const middleYear = Math.floor((decadeRange.start + decadeRange.end) / 2);
  
  console.log(`All attempts failed. Using emergency fallback for decade ${decadeKey}`);
  
  // Try one last approach - look for any decade with cached images
  for (const decade of Object.keys(imageCacheByDecade)) {
    if (imageCacheByDecade[decade].length > 0) {
      const randomIndex = Math.floor(Math.random() * imageCacheByDecade[decade].length);
      return imageCacheByDecade[decade][randomIndex];
    }
  }
  
  // Absolute last resort - if all else fails, use a dummy image from Wikimedia
  // These are guaranteed to exist and are representative of different eras
  const fallbackImages = [
    {
      title: "Execution of Louis XVI",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/71/Hinrichtung_Ludwig_des_XVI.png/800px-Hinrichtung_Ludwig_des_XVI.png",
      source: "Wikimedia Commons",
      year: 1793,
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      cachedAt: Date.now()
    },
    {
      title: "Abraham Lincoln portrait",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Abraham_Lincoln_O-77_matte_collodion_print.jpg/800px-Abraham_Lincoln_O-77_matte_collodion_print.jpg",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 1858,
      cachedAt: Date.now()
    },
    {
      title: "Wright brothers first flight",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7d/First_flight2.jpg/800px-First_flight2.jpg",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 1903,
      cachedAt: Date.now()
    },
    {
      title: "Victory Day in Times Square",
      url: "https://upload.wikimedia.org/wikipedia/en/thumb/9/95/VJ_Day_Times_Square_kiss.jpg/800px-VJ_Day_Times_Square_kiss.jpg",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 1945,
      cachedAt: Date.now()
    },
    {
      title: "Apollo 11 Lunar Landing",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/0/0e/Aldrin_Apollo_11_original.jpg/800px-Aldrin_Apollo_11_original.jpg",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 1969,
      cachedAt: Date.now()
    },
    {
      title: "Fall of the Berlin Wall",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/52/Thefalloftheberlinwall1989.JPG/800px-Thefalloftheberlinwall1989.JPG",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 1989,
      cachedAt: Date.now()
    },
    {
      title: "Barack Obama portrait",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8d/President_Barack_Obama.jpg/800px-President_Barack_Obama.jpg",
      source: "Wikimedia Commons",
      filename: "Execution_of_Louis_XVI.png",
description: "Historical illustration of the execution",
      year: 2012,
      cachedAt: Date.now()
    }
  ];
  
  // Find a fallback image from the appropriate decade if possible
  const decadeFallbacks = fallbackImages.filter(
    img => img.year >= decadeRange.start && img.year <= decadeRange.end
  );
  
  if (decadeFallbacks.length > 0) {
    const fallbackImage = decadeFallbacks[Math.floor(Math.random() * decadeFallbacks.length)];
    // Add to cache
    imageCacheByDecade[decadeKey].push(fallbackImage);
    return fallbackImage;
  }
  
  // Truly last resort - just pick any fallback image
  const fallbackImage = fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
  imageCacheByDecade[decadeKey].push(fallbackImage);
  return fallbackImage;
}

// Route to get a random image with year information
router.get('/', async (req: Request, res: Response) => {
  try {
    // Check for refresh parameter
    const forceRefresh = req.query.refresh === 'true';
    
    // Check for decade parameter
    let targetDecade: { start: number, end: number } | undefined;
    if (req.query.decade) {
      const decadeString = req.query.decade as string;
      const [start, end] = decadeString.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        targetDecade = { start, end };
      }
    }
    
    // Clear cache if forced refresh
    if (forceRefresh) {
      if (targetDecade) {
        const decadeKey = `${targetDecade.start}-${targetDecade.end}`;
        imageCacheByDecade[decadeKey] = [];
      } else {
        Object.keys(imageCacheByDecade).forEach(key => {
          imageCacheByDecade[key] = [];
        });
      }
    }
    
    const image = await getRandomImageWithYear(targetDecade);
    res.json(image);
  } catch (error) {
    console.error('Error processing request:', error);
    // Even in case of error, we should return something
    const fallbackImage = {
      title: "Historical photograph",
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Apollo_11_first_step.jpg/800px-Apollo_11_first_step.jpg",
      source: "Wikimedia Commons",
      year: 1969
    };
    res.json(fallbackImage);
  }
});

export default router;