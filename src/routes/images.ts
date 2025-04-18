import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData } from '../utils/wikimediaHelper';
import logger from '../utils/logger';
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';
import rateLimit from 'express-rate-limit';
import { ProcessedDistribution, ProcessedDistributionPoint } from '../types/types';

dotenv.config();

const router = express.Router();

// Cache expiration time
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100;
const MIN_YEAR = 1850; // Minimum year allowed for images
const TARGET_TIMEZONE = 'America/Chicago'; // Central Time

// Get current year for max year limit
const CURRENT_YEAR = new Date().getFullYear();

// Decade ranges to ensure even distribution
const DECADE_RANGES = [
  { start: 1850, end: 1899, weight: 1 },  // Less weight for oldest photos
  { start: 1900, end: 1919, weight: 2 },
  { start: 1920, end: 1939, weight: 3 },
  { start: 1940, end: 1959, weight: 3 },
  { start: 1960, end: 1979, weight: 3 },
  { start: 1980, end: 1999, weight: 3 },
  { start: 2000, end: CURRENT_YEAR, weight: 5 }
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
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg'];


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
  'Category:Street_photography',
  'Category:Photographs',
  'Category:People_in_photographs',
  'Category:Group_photographs',
  'Category:Color_photographs',
  'Category:Black_and_white_photographs',
  'Category:Digital_photographs',
  'Category:Photographers',
  'Category:Vintage_photographs',
  'Category:Festival_photographs',
  'Category:Event_photographs'
];

// Maximum number of API retries
const MAX_RETRIES = 3;
const IMAGES_PER_REQUEST = 100;

// --- Rate Limiter Configuration ---
const submitLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 15, // Limit each IP to 15 submit requests per 24 hours
    message: { error: 'Too many submission attempts from this IP, please try again after 24 hours' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    keyGenerator: (req: Request): string => {
        // Use 'x-forwarded-for' if behind a proxy, otherwise fallback
        const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress;
        return ip || 'unknown-ip'; // Provide a fallback key
    },
    handler: (req: Request, res: Response, next: NextFunction, options: any) => {
        const ip = options.keyGenerator(req);
        logger.warn(`[Rate Limit Blocked] IP: ${ip} exceeded submit limit for date: ${req.body.date || 'N/A'}`);
        res.status(options.statusCode).send(options.message);
    }
});
// --- End Rate Limiter Configuration ---

// Helper function to check if a file is a photograph by its extension
function isPhotoFile(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return ALLOWED_EXTENSIONS.some(ext => lowerFilename.endsWith(ext));
}

// Helper function to determine if metadata indicates a real photograph
function isLikelyRealPhoto(metadata: any): boolean {
  if (!metadata) return false;
  
  // Accept more images by being more lenient with metadata checks
  
  // Check for camera information (strong indicators)
  if (metadata.Artist || metadata.Make || metadata.Model) return true;
  
  // Accept images with copyright information as they're likely real photos
  if (metadata.Copyright || metadata.LicenseShortName) return true;
  
  // Check for photo-specific categories with broader terms
  if (metadata.Categories) {
    const categories = metadata.Categories.value || '';
    const photoKeywords = ['photograph', 'photo', 'portrait', 'camera', 'picture', 'image', 'snapshot'];
    const negativeKeywords = ['drawing', 'illustration', 'clipart', 'diagram', 'logo', 'chart'];
    
    if (photoKeywords.some(keyword => categories.toLowerCase().includes(keyword)) &&
        !negativeKeywords.some(keyword => categories.toLowerCase().includes(keyword))) {
      return true;
    }
  }
  
  // Check for description suggesting it's a photograph with broader terms
  if (metadata.ImageDescription) {
    const description = metadata.ImageDescription.value || '';
    const photoKeywords = ['photograph', 'photo', 'taken', 'camera', 'picture', 'captured', 'shot', 'image'];
    const negativeKeywords = ['drawing', 'illustration', 'clipart', 'diagram', 'logo', 'chart'];
    
    if (photoKeywords.some(keyword => description.toLowerCase().includes(keyword)) &&
        !negativeKeywords.some(keyword => description.toLowerCase().includes(keyword))) {
      return true;
    }
  }

  // Check if the file has a date that looks like a photo date
  if (metadata.DateTimeOriginal || metadata.DateTime || metadata.DateTimeDigitized) {
    return true;
  }
  
  // More lenient check: if it has author information, it might be a photo
  if (metadata.AuthorCreditText || metadata.Artist || metadata.Credit) {
    return true;
  }
  
  // Accept images with GPS data as they're almost certainly photographs
  if (metadata.GPSLatitude || metadata.GPSLongitude) {
    return true;
  }
  
  // If it has credit or attribution, it's more likely to be a real photo
  if (metadata.Attribution || metadata.Credit) {
    return true;
  }
  
  // If the mime type is known to be a photo type, that's a good indicator
  if (metadata.MIMEType && 
      (metadata.MIMEType.value?.includes('image/jpeg') || 
       metadata.MIMEType.value?.includes('image/png'))) {
    return true;
  }
  
  return false;
}

// Function to extract year from metadata with higher confidence
function extractYearWithConfidence(metadata: any, uploadYear: number): { year: number, confidence: 'high' | 'medium' | 'low' } {
  if (!metadata) return { year: uploadYear, confidence: 'medium' }; // Changed from low to medium
  
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
  const dateFields = ['DateTime', 'DateTimeDigitized', 'MetadataDate', 'CreateDate', 'ModifyDate'];
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
  
  // Use upload year but with medium confidence (not low)
  if (uploadYear >= MIN_YEAR && uploadYear <= CURRENT_YEAR) {
    return { year: uploadYear, confidence: 'medium' };
  }

  // Accept years from other metadata fields
  if (metadata.DateCreated) {
    const dateString = metadata.DateCreated.value;
    const yearMatch = dateString.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      const year = parseInt(yearMatch[0]);
      if (year >= MIN_YEAR && year <= CURRENT_YEAR) {
        return { year, confidence: 'medium' };
      }
    }
  }
  
  // If all else fails but we need a year within our range
  return { year: Math.floor(Math.random() * (CURRENT_YEAR - MIN_YEAR + 1)) + MIN_YEAR, confidence: 'low' };
}


/**
 * Process distribution data to generate percentile ranks and curve points
 * @param distributions Raw distribution data with individual score entries
 * @param userScore Optional user score to calculate specific percentile for
 * @param pointCount Number of points to generate for the curve (default 25)
 * @returns Processed distribution data with percentiles and curve points
 */
function processDistributionData(
    distributions: Array<{ score: number; count: number }>,
    userScore?: number,
    step: number = 25
): ProcessedDistribution {
    // Handle empty/null distributions
    if (!distributions) {
        console.warn("[processDistributionData] Received null/undefined distributions array.");
        return {
            percentileRank: undefined,
            curvePoints: [
                { score: 0, density: 0, percentile: 0 },
                { score: 5000, density: 0, percentile: 100 }
            ],
            totalParticipants: 0,
            minScore: 0,
            maxScore: 0,
            medianScore: 0
        };
    }

    const totalParticipants = distributions.reduce((sum, item) => sum + (item.count || 0), 0);

    // Handle 0 participants
    if (totalParticipants === 0) {
        console.log("[processDistributionData] 0 participants, returning default structure.");
        return {
            percentileRank: undefined,
            curvePoints: [
                { score: 0, density: 0, percentile: 0 },
                { score: 5000, density: 0, percentile: 100 }
            ],
            totalParticipants: 0,
            minScore: 0,
            maxScore: 0,
            medianScore: 0
        };
    }

    // Flatten scores for KDE calculation
    const allScores: number[] = [];
    distributions.forEach(dist => {
        for (let i = 0; i < (dist.count || 0); i++) {
            allScores.push(dist.score);
        }
    });

    const n = allScores.length;
    const bandwidth = 175;
    const minScoreDomain = 0;
    const maxScoreDomain = 5000;

    // Gaussian kernel function
    const gaussianKernel = (u: number): number => (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * u * u);

    // Calculate KDE points
    const kdePointsRaw: Array<{ score: number, density: number }> = [];
    for (let x = minScoreDomain; x <= maxScoreDomain; x += step) {
        let density = 0;
        for (const score of allScores) {
            const u = (x - score) / bandwidth;
            density += gaussianKernel(u);
        }
        density /= (n * bandwidth);
        kdePointsRaw.push({ score: x, density });
    }

    // Normalize densities
    let maxDensity = 0;
    kdePointsRaw.forEach(p => {
        if (p.density > maxDensity) maxDensity = p.density;
    });
    if (maxDensity > 0) {
        kdePointsRaw.forEach(p => {
            p.density /= maxDensity;
        });
    }

    // Calculate percentiles and create final curve points
    const finalCurvePoints: ProcessedDistributionPoint[] = [];
    let cumulativeCount = 0;
    let distIndex = 0;
    const sortedDistributions = [...distributions].sort((a, b) => a.score - b.score);

    for (const kdePoint of kdePointsRaw) {
        while (distIndex < sortedDistributions.length && sortedDistributions[distIndex].score <= kdePoint.score) {
            cumulativeCount += sortedDistributions[distIndex].count || 0;
            distIndex++;
        }
        const percentile = totalParticipants > 0 ? Math.round((cumulativeCount / totalParticipants) * 100) : 0;
        finalCurvePoints.push({
            score: kdePoint.score,
            density: kdePoint.density,
            percentile
        });
    }

    // Ensure we have points at domain boundaries
    if (finalCurvePoints.length === 0) {
        finalCurvePoints.push(
            { score: 0, density: 0, percentile: 0 },
            { score: 5000, density: 0, percentile: 100 }
        );
    }

    // Calculate summary statistics
    const scoresFromDist = [...allScores].sort((a, b) => a - b);
    const minScore = scoresFromDist[0] ?? 0;
    const maxScore = scoresFromDist[scoresFromDist.length - 1] ?? 0;
    let medianScore: number;
    const mid = Math.floor(n / 2);
    if (n === 0) {
        medianScore = 0;
    } else if (n % 2 === 0) {
        medianScore = Math.round((scoresFromDist[mid - 1] + scoresFromDist[mid]) / 2);
    } else {
        medianScore = scoresFromDist[mid];
    }

    // Calculate user percentile rank (only if in top 50%)
    let percentileRank: number | undefined = undefined;
    if (userScore !== undefined && n > 0) {
        let scoresBelow = 0;
        let scoresEqual = 0;
        const sortedScores = [...allScores].sort((a, b) => a - b);
        for (const s of sortedScores) {
            if (s < userScore) scoresBelow++;
            else if (s === userScore) scoresEqual++;
            else break;
        }
        const rawPercentile = ((scoresBelow + (scoresEqual / 2)) / n) * 100;
        const topPercent = 100 - rawPercentile;
        if (topPercent <= 50) {
            percentileRank = Math.round(topPercent);
        }
    }

    // Return final object with explicitly mapped curve points
    return {
        percentileRank,
        curvePoints: finalCurvePoints.map(p => ({
            score: p.score,
            density: p.density,
            percentile: p.percentile
        })),
        totalParticipants,
        minScore,
        maxScore,
        medianScore
    };
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
        if (year < decadeRange.start || year > decadeRange.end) {
           return null;
         }
         if (confidence === 'low' && year < 1950) {
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
  // Calculate the total weight
  const totalWeight = DECADE_RANGES.reduce((sum, range) => sum + range.weight, 0);
  
  // Generate a random value between 0 and the total weight
  const randomValue = Math.random() * totalWeight;
  
  // Use the random value to select a decade range based on its weight
  let weightSum = 0;
  for (const range of DECADE_RANGES) {
    weightSum += range.weight;
    if (randomValue <= weightSum) {
      return { start: range.start, end: range.end };
    }
  }
  
  // Fallback (should never reach here if weights are positive)
  return DECADE_RANGES[DECADE_RANGES.length - 1];
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
        if (confidence === 'low' && year < 1950) {
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
async function getRandomImageWithYear(targetDecade?: { start: number, end: number }){
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
  return {
    title: "Historical photograph",
    url: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Apollo_11_first_step.jpg/800px-Apollo_11_first_step.jpg",
    source: "Wikimedia Commons",
    year: Math.floor((decadeRange.start + decadeRange.end) / 2),
    cachedAt: Date.now(),
    description: "Fallback image - no images found for this decade range",
    filename: "Apollo_11_first_step.jpg"
  };

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

/**
 * POST /api/images/daily-challenge/submit
 * Submit a score for today's challenge
 */
router.post('/daily-challenge/submit', submitLimiter, async (req: Request, res: Response): Promise<void> => {
    const sourceIp = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || 'unknown-ip';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const { score, date } = req.body;

    // --- STEP 1.1: INPUT VALIDATION ---
    const numericScore = Number(score); // Convert score to number
    
    if (score === undefined || score === null || isNaN(numericScore) || numericScore < 0 || numericScore > 5000) {
        logger.warn(`[Submit Invalid Score] IP: ${sourceIp}, UA: "${userAgent}", Received invalid score: "${score}", Date: ${date}`);
        res.status(400).json({ error: `Invalid score value submitted. Score must be a number between 0 and 5000.` });
        return;
    }
    // --- END VALIDATION ---

    // Log the validated request
    logger.info(`[Submit Received Validated] IP: ${sourceIp}, UA: "${userAgent}", Score: ${numericScore}, Date: ${date}`);

    // Add aggressive logging after validation
    logger.info(`[Submit Processing] IP: ${sourceIp}, Score: ${numericScore}, Date: ${date}. Validation passed. Proceeding to update DB.`);

    try {
        let startDate: Date, endDate: Date;
        let queryDateString: string;

        if (date) {
            queryDateString = date as string;
            startDate = new Date(queryDateString + 'T00:00:00.000Z');
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            if (isNaN(startDate.getTime())) {
                logger.warn(`[Submit Invalid Date] IP: ${sourceIp}, Invalid date format: ${date}`);
                res.status(400).json({ error: 'Invalid date format' });
                return;
            }
            logger.info(`[Submit] Processing for specific date ${queryDateString} (UTC)`);
        } else {
            const now = new Date();
            queryDateString = formatInTimeZone(now, TARGET_TIMEZONE, 'yyyy-MM-dd');
            startDate = toZonedTime(`${queryDateString}T00:00:00`, TARGET_TIMEZONE);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            logger.info(`[Submit] Processing for current CT date ${queryDateString} (UTC range: ${startDate.toISOString()} to ${endDate.toISOString()})`);
        }

        // --- STEP 1.4: Use Atomic Increment for Completions ---
        // Find and atomically increment completions count first
        const updatedChallenge = await DailyChallenge.findOneAndUpdate(
            {
                date: { $gte: startDate, $lt: endDate },
                active: true
            },
            { $inc: { 'stats.completions': 1 } },
            { new: true } // Return the updated document
        );

        if (!updatedChallenge) {
            logger.warn(`[Submit Not Found] Challenge not found for date: ${queryDateString}, IP: ${sourceIp}`);
            res.status(404).json({ error: 'No challenge found for this date' });
            return;
        }

        // Add logging before distribution update
        logger.info(`[Submit DB Update] Challenge ID: ${updatedChallenge._id}, About to update distribution for score: ${numericScore}`);

        // --- Now update distributions and average score (Non-atomic part) ---
        const existingScoreIndex = updatedChallenge.stats.distributions.findIndex(d => d.score === numericScore);
        if (existingScoreIndex > -1) {
            // Atomically increment count for existing score distribution entry
            await DailyChallenge.updateOne(
                { _id: updatedChallenge._id, 'stats.distributions.score': numericScore },
                { $inc: { 'stats.distributions.$.count': 1 } }
            );
            // Fetch again to get the updated count for avg score calculation
            const refreshedChallengeForAvg = await DailyChallenge.findById(updatedChallenge._id);
            if(refreshedChallengeForAvg) updatedChallenge.stats = refreshedChallengeForAvg.stats;
        } else {
            // Atomically add the new score distribution entry
            await DailyChallenge.updateOne(
                { _id: updatedChallenge._id },
                { $push: { 'stats.distributions': { score: numericScore, count: 1 } } }
            );
            // Fetch again to get the updated distribution for avg score calculation
            const refreshedChallengeForAvg = await DailyChallenge.findById(updatedChallenge._id);
            if(refreshedChallengeForAvg) updatedChallenge.stats = refreshedChallengeForAvg.stats;
        }

        // Recalculate average score using the correct total completions
        const totalScoreSum = updatedChallenge.stats.distributions.reduce((sum, dist) => sum + (dist.score * dist.count), 0);
        const totalCompletions = updatedChallenge.stats.completions; // Use the already incremented value
        updatedChallenge.stats.averageScore = totalCompletions > 0 ? totalScoreSum / totalCompletions : 0;

        // Recalculate processed distribution
        const processedData = processDistributionData(
            updatedChallenge.stats.distributions,
            numericScore,
            25
        );
        updatedChallenge.stats.processedDistribution = processedData;

        // Save the non-atomic updates (averageScore, processedDistribution)
        await updatedChallenge.save();
        logger.info(`[Submit Success] Challenge ${updatedChallenge._id} stats updated for IP: ${sourceIp}. Completions: ${updatedChallenge.stats.completions}`);

        // Create the response object matching frontend expectations
        const responseData = {
            message: 'Score submitted successfully',
            stats: {
                averageScore: updatedChallenge.stats.averageScore,
                completions: updatedChallenge.stats.completions,
                processedDistribution: processedData
            }
        };
        logger.info(`[Submit Response] Sending response for IP: ${sourceIp}, Score: ${numericScore}`);
        res.status(200).json(responseData);

    } catch (err) {
        logger.error(`[Submit Error] IP: ${sourceIp}, Score: ${score}, Date: ${date}`, err);
        res.status(500).json({ error: 'Internal server error during score update' });
    }
});

/**
 * GET /api/images/daily-challenge/distribution
 * Get processed distribution data for a specific date
 */
router.get(
  '/daily-challenge/distribution',
  (async (req, res) => {
    try {
      let targetDate: Date;
      
      // Parse the date parameter
      if (req.query.date) {
        const dateStr = req.query.date as string;
        targetDate = new Date(dateStr);
        if (isNaN(targetDate.getTime())) {
          return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }
      } else {
        // Default to today
        targetDate = new Date();
      }
      
      // Set to ET midnight instead of UTC
      targetDate = toZonedTime(`${targetDate.toISOString().split('T')[0]}T00:00:00`, TARGET_TIMEZONE);
      const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
      
      // Find the challenge
      const challenge = await DailyChallenge.findOne({
        date: { 
          $gte: targetDate,
          $lt: nextDay
        },
        active: true
      });
      
      if (!challenge || !challenge.stats || !challenge.stats.distributions) {
        return res.status(404).json({ 
          error: 'No distribution data available for this date' 
        });
      }
      
      // Get the optional user score parameter
      const userScore = req.query.userScore 
        ? parseInt(req.query.userScore as string, 10) 
        : undefined;
      
      // Get the optional point count parameter
      const pointCount = req.query.points 
        ? parseInt(req.query.points as string, 10) 
        : 25;
      
      // Process the distribution data
      const processedData = processDistributionData(
        challenge.stats.distributions,
        userScore,
        pointCount
      );
      
      // Return the processed data
      res.status(200).json({
        date: targetDate.toISOString().split('T')[0],
        averageScore: challenge.stats.averageScore,
        completions: challenge.stats.completions,
        distribution: processedData
      });
    } catch (error) {
      logger.error('Error fetching distribution data:', error);
      res.status(500).json({ error: 'Failed to fetch distribution data' });
    }
  }) as RequestHandler
);

/**
 * GET /api/images/daily-challenge/stats
 * Get stats for today's challenge
 */
router.get('/daily-challenge/stats', async (req, res) => {
  try {
    let startDate: Date, endDate: Date;
    let queryDateString: string;

    if (req.query.date) {
      queryDateString = req.query.date as string;
      // Use UTC boundaries for specific date query
      startDate = new Date(queryDateString + 'T00:00:00.000Z');
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      if (isNaN(startDate.getTime())) {
        res.status(400).json({ error: 'Invalid date format' });
        return;
      }
      console.log(`[Stats Endpoint] Querying for specific date ${queryDateString} (UTC)`);
    } else {
      // Use CT logic to find 'today's' date if no date query param
      const now = new Date();
      queryDateString = formatInTimeZone(now, TARGET_TIMEZONE, 'yyyy-MM-dd');
      startDate = toZonedTime(`${queryDateString}T00:00:00`, TARGET_TIMEZONE);
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      console.log(`[Stats Endpoint] Querying for current CT date ${queryDateString} (UTC range: ${startDate.toISOString()} to ${endDate.toISOString()})`);
    }

    const challenge = await DailyChallenge.findOne({
      date: { $gte: startDate, $lt: endDate },
      active: true
    });

    if (!challenge) {
      res.status(404).json({ error: 'No challenge found for this date' });
      return;
    }

    // ... rest of stats logic ...
    res.json(challenge);
  } catch (err) {
    console.error('[Stats Endpoint] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// src/routes/images.ts
// import logger from '../utils/logger'; // Temporarily comment out or remove if not used elsewhere in file after changes

router.get('/daily-challenge/date/:date', (async (req: Request, res: Response): Promise<void> => {
  // ***** SIMPLE CONSOLE LOG AT START *****
  console.log(`[DATE ROUTE - CONSOLE] Request received for date: ${req.params.date}`);
  // ***** END SIMPLE CONSOLE LOG *****

  try {
      const { date } = req.params;
      const startDate = new Date(date + 'T00:00:00.000Z');
      const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      if (isNaN(startDate.getTime())) {
          console.error(`[DATE ROUTE - CONSOLE] Invalid date format: ${date}`); // Use console.error
          res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
          return;
      }

      console.log(`[DATE ROUTE - CONSOLE] Querying MongoDB for date: ${date}`); // Use console.log

      const challenge = await DailyChallenge.findOne({
          date: { $gte: startDate, $lt: endDate },
          active: true
      })
      .select('_id images date active stats.processedDistribution');

      if (challenge) {
           console.log(`[DATE ROUTE - CONSOLE] Found challenge _id: ${challenge._id}`); // Use console.log
           // Add a simple check for stats presence
           if(challenge.stats) {
               console.log(`[DATE ROUTE - CONSOLE] challenge.stats object exists.`);
               if (challenge.stats.distributions !== undefined) {
                  console.warn(`[DATE ROUTE - CONSOLE] UNEXPECTED: challenge.stats.distributions exists.`);
               } else {
                  console.log(`[DATE ROUTE - CONSOLE] OK: challenge.stats.distributions is undefined.`);
               }
           } else {
               console.warn(`[DATE ROUTE - CONSOLE] challenge.stats is missing.`);
           }
      } else {
          console.warn(`[DATE ROUTE - CONSOLE] Challenge not found for date: ${date}`); // Use console.warn
          res.status(404).json({ error: 'No daily challenge available for this date' });
          return;
      }

      console.log(`[DATE ROUTE - CONSOLE] Preparing to send response for date: ${date}`); // Use console.log
      res.status(200).json(challenge);

  } catch (error) {
      // ***** USE CONSOLE.ERROR IN CATCH *****
      console.error(`[DATE ROUTE - CONSOLE] Error fetching challenge for date ${req.params.date}:`, error);
      // ***** END CONSOLE.ERROR *****
      res.status(500).json({ error: 'Server error fetching daily challenge' });
  }
}) as RequestHandler);

// ADMIN ROUTES

const verifyAdmin: RequestHandler = (req, res, next) => {
  const adminKey = req.headers['x-admin-key'];
  
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  next();
};



/**
 * POST /api/images/daily-challenge/admin/create
 * Create a new daily challenge (Admin only)
 */
router.post('/daily-challenge/admin/create', verifyAdmin, (async (req, res) => {
  try {
    const { date, filenames } = req.body;
    
    if (!date || !Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ 
        error: 'Invalid request. Required: date (YYYY-MM-DD) and filenames array' 
      });
    }
    
    // Parse date
    const challengeDate = toZonedTime(`${date}T00:00:00`, TARGET_TIMEZONE);
    
    if (isNaN(challengeDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    // Check if a challenge already exists for this date
    const existingChallenge = await DailyChallenge.findOne({
      date: challengeDate
    });
    
    if (existingChallenge) {
      return res.status(409).json({ 
        error: 'A challenge already exists for this date',
        challengeId: existingChallenge._id
      });
    }
    
    // Fetch complete image data from Wikimedia
    const imageData = await fetchMultipleImageData(filenames);
    
    if (imageData.length === 0) {
      return res.status(400).json({ 
        error: 'Failed to fetch any valid image data from the provided filenames' 
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
      challengeId: newChallenge._id,
      imageCount: imageData.length
    });
  } catch (error) {
    logger.error('Error creating daily challenge:', error);
    res.status(500).json({ error: 'Failed to create daily challenge' });
  }
}) as RequestHandler);

/**
 * GET /api/images/daily-challenge/dates
 * Returns all dates for which a daily challenge exists.
 */
router.get('/daily-challenge/dates', async (req: Request, res: Response) => {
  try {
    // Optionally, you can restrict this to active challenges only
    const challenges = await DailyChallenge.find({ active: true }, { date: 1 }).sort({ date: 1 });
    // Normalize each date to YYYY-MM-DD format
    const dates = challenges.map(challenge => 
      new Date(challenge.date).toISOString().split('T')[0]
    );
    res.status(200).json({ dates });
  } catch (error) {
    console.error('Error fetching challenge dates:', error);
    res.status(500).json({ error: 'Failed to fetch challenge dates' });
  }
});

/**
 * PUT /api/images/daily-challenge/admin/:id
 * Update an existing daily challenge (Admin only)
 */
router.put('/daily-challenge/admin/:id', verifyAdmin, (async (req, res) => {
  try {
    const { id } = req.params;
    const { date, filenames, active } = req.body;
    
    // Find the challenge
    const challenge = await DailyChallenge.findById(id);
    
    if (!challenge) {
      return res.status(404).json({ error: 'Challenge not found' });
    }
    
    // Update date if provided
    if (date) {
      const challengeDate = new Date(date);
      challengeDate.setUTCHours(0, 0, 0, 0);
      
      if (isNaN(challengeDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
      
      challenge.date = challengeDate;
    }
    
    // Update images if filenames provided
    if (Array.isArray(filenames) && filenames.length > 0) {
      const imageData = await fetchMultipleImageData(filenames);
      
      if (imageData.length === 0) {
        return res.status(400).json({ 
          error: 'Failed to fetch any valid image data from the provided filenames' 
        });
      }
      
      challenge.images = imageData;
    }
    
    // Update active status if provided
    if (typeof active === 'boolean') {
      challenge.active = active;
    }
    
    await challenge.save();
    
    res.status(200).json({
      message: 'Daily challenge updated successfully',
      challenge: {
        id: challenge._id,
        date: challenge.date,
        imageCount: challenge.images.length,
        active: challenge.active
      }
    });
  } catch (error) {
    logger.error('Error updating daily challenge:', error);
    res.status(500).json({ error: 'Failed to update daily challenge' });
  }
}) as RequestHandler);

/**
 * GET /api/images/daily-challenge/admin/list
 * List all daily challenges (Admin only)
 */
router.get('/daily-challenge/admin/list', verifyAdmin, (async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const pageNumber = parseInt(page as string, 10);
    const limitNumber = parseInt(limit as string, 10);
    
    const challenges = await DailyChallenge.find()
      .sort({ date: -1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber)
      .select('date active stats.completions _id');
    
    const total = await DailyChallenge.countDocuments();
    
    res.status(200).json({
      challenges,
      totalPages: Math.ceil(total / limitNumber),
      currentPage: pageNumber
    });
  } catch (error) {
    logger.error('Error listing daily challenges:', error);
    res.status(500).json({ error: 'Failed to list daily challenges' });
  }
}) as RequestHandler);

// GET /api/images/daily-challenge/today
router.get('/daily-challenge/today', async (req, res) => {
  try {
    // 1. Get the current date string in the target timezone
    const now = new Date(); // Current time UTC (usually from server)
    const todayDateStringCT = formatInTimeZone(now, TARGET_TIMEZONE, 'yyyy-MM-dd'); // Gets '2025-04-15' based on CT

    console.log(`[Today Endpoint] Current CT Date: ${todayDateStringCT}`);

    // 2. Construct UTC query boundaries based on the CT date string
    const startDate = toZonedTime(`${todayDateStringCT}T00:00:00`, TARGET_TIMEZONE); // Midnight CT start converted to UTC
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000); // 24 hours later UTC

    console.log(`[Today Endpoint] Querying for challenge >= ${startDate.toISOString()} and < ${endDate.toISOString()} (based on CT date)`);

    // 3. Query using UTC boundaries
    const challenge = await DailyChallenge.findOne({
      date: {
        $gte: startDate,
        $lt: endDate
      },
      active: true
    });

    if (!challenge) {
      console.log(`[Today Endpoint] No challenge found for CT date ${todayDateStringCT}`);
      res.status(404).json({ error: 'No daily challenge available for today' });
      return;
    }
    res.json(challenge);

  } catch (err) {
    console.error('[Today Endpoint] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
