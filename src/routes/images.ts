import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import DailyChallenge from '../models/DailyChallenge';
import { fetchImageData, fetchMultipleImageData } from '../utils/wikimediaHelper';
import logger from '../utils/logger';

dotenv.config();

const router = express.Router();

// Cache expiration time
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100;
const MIN_YEAR = 1850; // Minimum year allowed for images

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

function setCentralTimeMidnight(date: Date): Date {
  // Convert the input date to a string in CT timezone, keeping only the date part
  const ctDateStr = date.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  
  // Parse the string back to a date object (will be in local timezone)
  const [month, day, year] = ctDateStr.split('/').map(Number);
  
  // Create a new date with the CT date components but at UTC midnight
  const result = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  
  return result;
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
  distributions: Array<{score: number, count: number}>,
  userScore?: number,
  pointCount: number = 25
): {
  percentileRank?: number;
  curvePoints: Array<{score: number, count: number, percentile: number}>;
  totalParticipants: number;
  minScore: number;
  maxScore: number;
  medianScore: number;
} {
  
  // Return empty data if no distributions
  if (!distributions || distributions.length === 0) {
    return {
      percentileRank: undefined,
      curvePoints: [],
      totalParticipants: 0,
      minScore: 0,
      maxScore: 0,
      medianScore: 0
    };
  }

  // Sort distributions by score (ascending)
  const sortedDistributions = [...distributions].sort((a, b) => a.score - b.score);
  
  // Calculate total participants and cumulative counts
  const totalParticipants = sortedDistributions.reduce((sum, item) => sum + item.count, 0);
  
  if (totalParticipants === 0) {
    return {
      percentileRank: undefined,
      curvePoints: [],
      totalParticipants: 0,
      minScore: 0,
      maxScore: 0,
      medianScore: 0
    };
  }
  
  // Calculate cumulative counts and percentiles
  let cumulativeCount = 0;
  const distributionsWithPercentiles = sortedDistributions.map(item => {
    cumulativeCount += item.count;
    return {
      score: item.score,
      count: item.count,
      cumulativeCount,
      percentile: Math.round((cumulativeCount / totalParticipants) * 100)
    };
  });
  
  // Min, max scores
  const minScore = sortedDistributions[0].score;
  const maxScore = sortedDistributions[sortedDistributions.length - 1].score;
  
  // Calculate median score
  let medianScore = 0;
  const medianIndex = Math.floor(totalParticipants / 2);
  for (const item of distributionsWithPercentiles) {
    if (item.cumulativeCount >= medianIndex) {
      medianScore = item.score;
      break;
    }
  }
  
  // Calculate user's percentile rank if a score is provided
  let percentileRank: number | undefined = undefined;
  if (userScore !== undefined) {
    // Count scores below user's score AND scores equal to user's score
    let scoresBelow = 0;
    let scoresEqual = 0;
    
    for (const item of sortedDistributions) {
      if (item.score < userScore) {
        scoresBelow += item.count;
      } else if (item.score === userScore) {
        scoresEqual += item.count;
      }
    }
 

  // Calculate percentile using the "mid-point" approach for ties
  // This puts the user in the middle of the tied scores
  if (totalParticipants > 0) {
    // First calculate the raw percentile (including half of the ties)
    const rawPercentile = Math.round(((scoresBelow + (scoresEqual / 2)) / totalParticipants) * 100);
    
    // Convert to top X% format (e.g., top 25%)
    percentileRank = 100 - rawPercentile;
    
    // We want the top X% format, but we only want to highlight truly exceptional scores
    // Only highlight if in the top half of users
    if (percentileRank > 50) {
      percentileRank = undefined;
    }
  }
}
  
  // Generate curve points by taking a subset of the distribution
 // Generate curve points with fixed count
const targetPointCount = 15; // Lower this from 25 to 15
let curvePoints: Array<{score: number, count: number, percentile: number}> = [];

if (distributionsWithPercentiles.length <= targetPointCount) {
  // If we have fewer data points than requested, use all of them
  curvePoints = distributionsWithPercentiles.map(item => ({
    score: item.score,
    count: item.count,
    percentile: item.percentile
  }));
} else {
  // Always include first and last points
  const first = distributionsWithPercentiles[0];
  const last = distributionsWithPercentiles[distributionsWithPercentiles.length - 1];
  
  // Find points at specific percentile intervals
  const percentileSteps = Math.floor(100 / (targetPointCount - 1));
  const percentiles = [];
  
  // Create array of target percentiles
  for (let p = 0; p <= 100; p += percentileSteps) {
    if (percentiles.length < targetPointCount - 1) {
      percentiles.push(p);
    }
  }
  // Ensure 100th percentile is included
  if (percentiles[percentiles.length - 1] !== 100) {
    percentiles.push(100);
  }
  
  // Find the closest point for each percentile
  for (const targetPercentile of percentiles) {
    let closest = distributionsWithPercentiles[0];
    let minDiff = Math.abs(closest.percentile - targetPercentile);
    
    for (const point of distributionsWithPercentiles) {
      const diff = Math.abs(point.percentile - targetPercentile);
      if (diff < minDiff) {
        closest = point;
        minDiff = diff;
      }
    }
    
    // Add this point if not already included
    if (!curvePoints.some(p => p.score === closest.score)) {
      curvePoints.push({
        score: closest.score,
        count: closest.count,
        percentile: closest.percentile
      });
    }
  }
  
  // Sort by score
  curvePoints.sort((a, b) => a.score - b.score);
  
  // Ensure we have exactly targetPointCount points by adding or removing as needed
  if (curvePoints.length < targetPointCount) {
    // Find the largest gaps and add points there
    while (curvePoints.length < targetPointCount) {
      let maxGapIndex = 0;
      let maxGapSize = 0;
      
      for (let i = 0; i < curvePoints.length - 1; i++) {
        const gap = curvePoints[i + 1].score - curvePoints[i].score;
        if (gap > maxGapSize) {
          maxGapSize = gap;
          maxGapIndex = i;
        }
      }
      
      // Find a point between the two points with largest gap
      const leftScore = curvePoints[maxGapIndex].score;
      const rightScore = curvePoints[maxGapIndex + 1].score;
      const midScore = Math.floor((leftScore + rightScore) / 2);
      
      // Find the closest existing point to this score
      let closestPoint = distributionsWithPercentiles[0];
      let minDiff = Math.abs(closestPoint.score - midScore);
      
      for (const point of distributionsWithPercentiles) {
        const diff = Math.abs(point.score - midScore);
        if (diff < minDiff) {
          closestPoint = point;
          minDiff = diff;
        }
      }
      
      // Insert this point
      if (!curvePoints.some(p => p.score === closestPoint.score)) {
        curvePoints.splice(maxGapIndex + 1, 0, {
          score: closestPoint.score,
          count: closestPoint.count,
          percentile: closestPoint.percentile
        });
      } else {
        // If we can't add more unique points, break to avoid infinite loop
        break;
      }
    }
  } else if (curvePoints.length > targetPointCount) {
    // Remove points, but keep first and last
    const pointsToRemove = curvePoints.length - targetPointCount;
    
    // Calculate importance of each point (except first and last)
    const pointsWithImportance = curvePoints.slice(1, -1).map((point, idx) => {
      const actualIdx = idx + 1;
      const prev = curvePoints[actualIdx - 1];
      const next = curvePoints[actualIdx + 1];
      
      // Linear interpolation between prev and next
      const ratio = (point.score - prev.score) / (next.score - prev.score);
      const expectedCount = prev.count + ratio * (next.count - prev.count);
      
      // Importance is how much this point deviates from linear interpolation
      const importance = Math.abs(point.count - expectedCount);
      
      return { point, importance, index: actualIdx };
    });
    
    // Sort by importance (ascending, less important first)
    pointsWithImportance.sort((a, b) => a.importance - b.importance);
    
    // Remove least important points
    const indexesToRemove = pointsWithImportance
      .slice(0, pointsToRemove)
      .map(p => p.index)
      .sort((a, b) => b - a); // Sort descending to remove from end first
    
    for (const idx of indexesToRemove) {
      curvePoints.splice(idx, 1);
    }
  }
}

return {
  percentileRank,
  curvePoints,
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
 * GET /api/images/daily-challenge
 * Get today's challenge
 */
router.post('/daily-challenge/submit', (async (req, res) => {
  try {
    const { score, date } = req.body;
    
    // ...
    
    // Get today's date (start of day in CT) or use the provided date
    let targetDate: Date;
    if (date) {
      targetDate = new Date(date);
      if (isNaN(targetDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }
      targetDate = setCentralTimeMidnight(targetDate);
    } else {
      targetDate = setCentralTimeMidnight(new Date());
    }
    
    // Find the challenge for the target date
    const challenge = await DailyChallenge.findOne({
      date: { 
        $gte: targetDate,
        $lt: new Date(targetDate.getTime() + 24 * 60 * 60 * 1000)
      },
      active: true
    });
    
    if (!challenge) {
      return res.status(404).json({ error: 'No daily challenge available for this date' });
    }
    
    console.log(`Found challenge: ${challenge._id}`);
    
    // Initialize stats object if it doesn't exist
    if (!challenge.stats) {
      console.log("Initializing stats object");
      challenge.stats = {
        averageScore: 0,
        completions: 0,
        distributions: []
      };
    }
    
    // Ensure distributions array exists
    if (!challenge.stats.distributions) {
      console.log("Initializing distributions array");
      challenge.stats.distributions = [];
    }
    
    console.log("Stats before update:", JSON.stringify(challenge.stats));
    
    // Update stats
    // Increment completions
    challenge.stats.completions += 1;
    
    // Update average score
    const totalScore = challenge.stats.averageScore * (challenge.stats.completions - 1) + score;
    challenge.stats.averageScore = totalScore / challenge.stats.completions;
    
    // Store exact score in distributions (not rounded)
    const exactScore = Math.round(score); // Ensure it's an integer but keep exact value
    const existingDistribution = challenge.stats.distributions.find(d => d.score === exactScore);
    if (existingDistribution) {
      existingDistribution.count += 1;
    } else {
      challenge.stats.distributions.push({ score: exactScore, count: 1 });
      // Sort distributions by score
      challenge.stats.distributions.sort((a, b) => a.score - b.score);
    }
    
    console.log("Stats after update:", JSON.stringify(challenge.stats));
    
    // Process the distribution data for response
    const processedData = processDistributionData(
      challenge.stats.distributions,
      score // Include user's score to calculate their percentile
    );
    
    // Add processed data to the challenge
    challenge.stats.processedDistribution = processedData;
    
    // Save challenge with all updates in one operation
    await challenge.save();
    console.log("Challenge saved successfully with processed distribution");

    // Create response with processed data and raw stats
    const response = { 
      message: 'Score submitted successfully',
      stats: {
        averageScore: challenge.stats.averageScore,
        completions: challenge.stats.completions, 
        processedDistribution: processedData
      }
    };
    
    console.log("Sending response with processed data");
    res.status(200).json(response);
  } catch (error) {
    console.error('Error submitting score:', error);
    res.status(500).json({ error: 'Failed to submit score' });
  }
}) as RequestHandler);

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
      
      // Set to CT midnight instead of UTC
      targetDate = setCentralTimeMidnight(targetDate);
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
router.get(
  '/daily-challenge/stats',
  (async (req, res) => {
    try {
      let startDate: Date, endDate: Date;
      if (req.query.date) {
        // Parse the provided date in YYYY-MM-DD format
        const dateStr = req.query.date as string;
        const dateObj = new Date(dateStr);
        if (isNaN(dateObj.getTime())) {
          res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
          return;
        }
        startDate = setCentralTimeMidnight(dateObj);
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      } else {
        // Default to today if no date is provided
        startDate = setCentralTimeMidnight(new Date());
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      }
      
      // Find the daily challenge for the given day
      const challenge = await DailyChallenge.findOne({
        date: {
          $gte: startDate,
          $lt: endDate
        },
        active: true
      });
      
      if (!challenge || !challenge.stats) {
        res.status(404).json({ error: 'No daily challenge stats available for the selected date' });
        return;
      }
      
      // Return only the stats object
      res.status(200).json(challenge.stats);
      return;
    } catch (error) {
      logger.error('Error fetching daily challenge stats:', error);
      res.status(500).json({ error: 'Failed to fetch stats' });
      return;
    }
  }) as RequestHandler
);

router.get(
  '/daily-challenge/date/:date',
  (async (req: Request, res: Response): Promise<void> => {
    try {
      const { date } = req.params;
      const dateObj = new Date(date);

      // Validate date format
      if (isNaN(dateObj.getTime())) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        return;
      }
      
      // Normalize the date to start of day in CT instead of UTC
      const ctDate = setCentralTimeMidnight(dateObj);
      const nextDay = new Date(ctDate.getTime() + 24 * 60 * 60 * 1000);
      
      // Find the challenge for that day
      const challenge = await DailyChallenge.findOne({
        date: { 
          $gte: ctDate,
          $lt: nextDay
        },
        active: true
      });
      
      if (!challenge) {
        res.status(404).json({ error: 'No daily challenge available for this date' });
        return;
      }
      
      res.status(200).json(challenge);
    } catch (error) {
      console.error('Error fetching daily challenge by date:', error);
      res.status(500).json({ error: 'Server error fetching daily challenge' });
    }
  }) as RequestHandler
);

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
    const challengeDate = setCentralTimeMidnight(new Date(date));
    
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

router.get(
  '/daily-challenge/date/:date',
  (async (req: Request, res: Response): Promise<void> => {
    try {
      const { date } = req.params;
      const dateObj = new Date(date);

      // Validate date format
      if (isNaN(dateObj.getTime())) {
        res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        return;
      }
      
      // Normalize the date to start of day in CT instead of UTC
      const ctDate = setCentralTimeMidnight(dateObj);
      const nextDay = new Date(ctDate.getTime() + 24 * 60 * 60 * 1000);
      
      // Find the challenge for that day
      const challenge = await DailyChallenge.findOne({
        date: { 
          $gte: ctDate,
          $lt: nextDay
        },
        active: true
      });
      
      if (!challenge) {
        res.status(404).json({ error: 'No daily challenge available for this date' });
        return;
      }
      
      res.status(200).json(challenge);
    } catch (error) {
      console.error('Error fetching daily challenge by date:', error);
      res.status(500).json({ error: 'Server error fetching daily challenge' });
      return;
    }
  }) as RequestHandler
);



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
    // Get today's date (start of day in CT)
    const today = setCentralTimeMidnight(new Date());
    console.log("DEBUG - Today CT midnight:", today.toISOString());
    
    // Calculate tomorrow
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    console.log("DEBUG - Tomorrow CT midnight:", tomorrow.toISOString());
    
    // Log the query we're about to make
    console.log("DEBUG - Query:", {
      date: { 
        $gte: today.toISOString(),
        $lt: tomorrow.toISOString()
      },
      active: true
    });
    
    // Find active challenge for today
    const challenge = await DailyChallenge.findOne({
      date: { 
        $gte: today,
        $lt: tomorrow
      },
      active: true
    });
    
    console.log("DEBUG - Challenge found:", challenge ? 
      { id: challenge._id, date: challenge.date, imgCount: challenge.images.length } : 
      "No challenge found");

    if (!challenge) {
      res.status(404).json({ error: 'No daily challenge available for today' });
      return;
    }

    // Return the entire challenge document
    res.json(challenge);
    return;
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error fetching daily challenge' });
    return;
  }
});

export default router;
