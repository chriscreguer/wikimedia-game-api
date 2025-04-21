import fetch from 'node-fetch';
import { WikimediaImage } from '../types/wikimedia';
import logger from './logger';

/**
 * Fetches complete image data from Wikimedia Commons
 * @param filename The image filename (without "File:" prefix)
 * @returns Complete WikimediaImage object or null if fetch fails
 */
export async function fetchImageData(filename: string): Promise<WikimediaImage | null> {
  try {
    // Add "File:" prefix if not present
    const fullTitle = filename.startsWith('File:') ? filename : `File:${filename}`;
    
    // Get image info including upload date, URL, metadata, etc.
    const infoResponse = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fullTitle)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`,
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
      logger.warn(`No image info found for ${filename}`);
      return null;
    }
    
    const imageInfo = pages[pageId].imageinfo[0];
    
    // Extract year from metadata with high confidence
    let year = new Date().getFullYear(); // Default to current year as fallback
    let confidenceLevel = 'low';
    
    if (imageInfo.extmetadata) {
      // Try DateTimeOriginal first (highest confidence)
      if (imageInfo.extmetadata.DateTimeOriginal) {
        const dateString = imageInfo.extmetadata.DateTimeOriginal.value;
        const yearMatch = dateString.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
        if (yearMatch) {
          year = parseInt(yearMatch[0]);
          confidenceLevel = 'high';
        }
      } 
      // Try other date fields with medium confidence
      else if (imageInfo.extmetadata.DateTime) {
        const dateString = imageInfo.extmetadata.DateTime.value;
        const yearMatch = dateString.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
        if (yearMatch) {
          year = parseInt(yearMatch[0]);
          confidenceLevel = 'medium';
        }
      }
      // Look for year in description
      else if (imageInfo.extmetadata.ImageDescription) {
        const description = imageInfo.extmetadata.ImageDescription.value;
        const yearMatch = description.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/);
        if (yearMatch) {
          year = parseInt(yearMatch[0]);
          confidenceLevel = 'medium';
        }
      }
    }
    
    // Extract title without "File:" prefix
    const title = fullTitle.replace(/^File:/, '');
    
    logger.info(`Successfully fetched image data for ${filename}`, { confidenceLevel });
    
    return {
      title: title,
      url: imageInfo.url,
      source: 'Wikimedia Commons',
      year: year,
      description: imageInfo.extmetadata?.ImageDescription?.value || '',
      filename: title
    };
  } catch (error) {
    logger.error(`Error fetching image data for ${filename}:`, error);
    return null;
  }
}

/**
 * Fetches complete image data for multiple filenames
 * @param filenames Array of image filenames
 * @returns Array of successfully fetched WikimediaImage objects
 */
export async function fetchMultipleImageData(filenames: string[]): Promise<WikimediaImage[]> {
  logger.info(`Fetching data for ${filenames.length} images`);
  
  const imagePromises = filenames.map(filename => fetchImageData(filename));
  const results = await Promise.all(imagePromises);
  
  // Filter out nulls (failed fetches)
  const validImages = results.filter(img => img !== null) as WikimediaImage[];
  
  logger.info(`Successfully fetched ${validImages.length} of ${filenames.length} images`);
  return validImages;
}

/**
 * Extract filename from a Wikimedia URL
 * @param url The Wikimedia URL
 * @returns The decoded filename or null if invalid
 */
export function extractFilenameFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      
      // Verify it's a Wikimedia URL
      if (!urlObj.hostname.includes('wikimedia.org')) {
        return null;
      }
      
      const pathname = urlObj.pathname;
      const segments = pathname.split('/');
      
      // Filename is the last segment
      const encodedFilename = segments[segments.length - 1];
      
      // Decode URI component to handle special characters
      return decodeURIComponent(encodedFilename);
    } catch (error) {
      console.error('Invalid URL:', error);
      return null;
    }
  }

export interface YearExtractionResult {
    year: number;
    confidence: 'high' | 'medium' | 'low';
}

export function extractYearWithConfidence(extmetadata: any, uploadYear: number): YearExtractionResult {
    // Try to extract year from various metadata fields
    const possibleYearFields = [
        'DateTimeOriginal',
        'DateTimeDigitized',
        'DateTime',
        'DateCreated',
        'CreationDate'
    ];

    for (const field of possibleYearFields) {
        const value = extmetadata?.[field]?.value;
        if (value) {
            // Try to extract year from various date formats
            const yearMatch = value.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) {
                const year = parseInt(yearMatch[0]);
                if (year >= 1850 && year <= new Date().getFullYear()) {
                    return { year, confidence: 'high' };
                }
            }
        }
    }

    // If no year found in metadata, use upload year with medium confidence
    return { year: uploadYear, confidence: 'medium' };
}