"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchImageData = fetchImageData;
exports.fetchMultipleImageData = fetchMultipleImageData;
exports.extractFilenameFromUrl = extractFilenameFromUrl;
const node_fetch_1 = __importDefault(require("node-fetch"));
const logger_1 = __importDefault(require("./logger"));
/**
 * Fetches complete image data from Wikimedia Commons
 * @param filename The image filename (without "File:" prefix)
 * @returns Complete WikimediaImage object or null if fetch fails
 */
function fetchImageData(filename) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        try {
            // Add "File:" prefix if not present
            const fullTitle = filename.startsWith('File:') ? filename : `File:${filename}`;
            // Get image info including upload date, URL, metadata, etc.
            const infoResponse = yield (0, node_fetch_1.default)(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(fullTitle)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`, {
                headers: {
                    'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
                }
            });
            const infoData = yield infoResponse.json();
            const pages = infoData.query.pages;
            const pageId = Object.keys(pages)[0];
            if (!pages[pageId].imageinfo || !pages[pageId].imageinfo[0]) {
                logger_1.default.warn(`No image info found for ${filename}`);
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
            logger_1.default.info(`Successfully fetched image data for ${filename}`, { confidenceLevel });
            return {
                title: title,
                url: imageInfo.url,
                source: 'Wikimedia Commons',
                year: year,
                description: ((_b = (_a = imageInfo.extmetadata) === null || _a === void 0 ? void 0 : _a.ImageDescription) === null || _b === void 0 ? void 0 : _b.value) || '',
                filename: title
            };
        }
        catch (error) {
            logger_1.default.error(`Error fetching image data for ${filename}:`, error);
            return null;
        }
    });
}
/**
 * Fetches complete image data for multiple filenames
 * @param filenames Array of image filenames
 * @returns Array of successfully fetched WikimediaImage objects
 */
function fetchMultipleImageData(filenames) {
    return __awaiter(this, void 0, void 0, function* () {
        logger_1.default.info(`Fetching data for ${filenames.length} images`);
        const imagePromises = filenames.map(filename => fetchImageData(filename));
        const results = yield Promise.all(imagePromises);
        // Filter out nulls (failed fetches)
        const validImages = results.filter(img => img !== null);
        logger_1.default.info(`Successfully fetched ${validImages.length} of ${filenames.length} images`);
        return validImages;
    });
}
/**
 * Extract filename from a Wikimedia URL
 * @param url The Wikimedia URL
 * @returns The decoded filename or null if invalid
 */
function extractFilenameFromUrl(url) {
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
    }
    catch (error) {
        console.error('Invalid URL:', error);
        return null;
    }
}
//# sourceMappingURL=wikimediaHelper.js.map