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
const express_1 = __importDefault(require("express"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const dotenv_1 = __importDefault(require("dotenv"));
const DailyChallenge_1 = __importDefault(require("../models/DailyChallenge"));
const wikimediaHelper_1 = require("../utils/wikimediaHelper");
const logger_1 = __importDefault(require("../utils/logger"));
const date_fns_tz_1 = require("date-fns-tz");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
dotenv_1.default.config();
const router = express_1.default.Router();
// Cache expiration time
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_SIZE = 100;
const MIN_YEAR = 1850; // Minimum year allowed for images
const TARGET_TIMEZONE = 'America/Chicago'; // Central Time
// Get current year for max year limit
const CURRENT_YEAR = new Date().getFullYear();
// Decade ranges to ensure even distribution
const DECADE_RANGES = [
    { start: 1850, end: 1899, weight: 1 }, // Less weight for oldest photos
    { start: 1900, end: 1919, weight: 2 },
    { start: 1920, end: 1939, weight: 3 },
    { start: 1940, end: 1959, weight: 3 },
    { start: 1960, end: 1979, weight: 3 },
    { start: 1980, end: 1999, weight: 3 },
    { start: 2000, end: CURRENT_YEAR, weight: 5 }
];
// Cache to minimize API calls to Wikimedia, organized by decade
const imageCacheByDecade = {};
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
const submitLimiter = (0, express_rate_limit_1.default)({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 15, // Limit each IP to 15 submit requests per 24 hours
    message: { error: 'Too many submission attempts from this IP, please try again after 24 hours' },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    keyGenerator: (req) => {
        var _a;
        // Use 'x-forwarded-for' if behind a proxy, otherwise fallback
        const ip = ((_a = req.headers['x-forwarded-for']) === null || _a === void 0 ? void 0 : _a.toString().split(',')[0]) || req.socket.remoteAddress;
        return ip || 'unknown-ip'; // Provide a fallback key
    },
    handler: (req, res, next, options) => {
        const ip = options.keyGenerator(req);
        logger_1.default.warn(`[Rate Limit Blocked] IP: ${ip} exceeded submit limit for date: ${req.body.date || 'N/A'}`);
        res.status(options.statusCode).send(options.message);
    }
});
// --- End Rate Limiter Configuration ---
// Helper function to check if a file is a photograph by its extension
function isPhotoFile(filename) {
    const lowerFilename = filename.toLowerCase();
    return ALLOWED_EXTENSIONS.some(ext => lowerFilename.endsWith(ext));
}
// Helper function to determine if metadata indicates a real photograph
function isLikelyRealPhoto(metadata) {
    var _a, _b;
    if (!metadata)
        return false;
    // Accept more images by being more lenient with metadata checks
    // Check for camera information (strong indicators)
    if (metadata.Artist || metadata.Make || metadata.Model)
        return true;
    // Accept images with copyright information as they're likely real photos
    if (metadata.Copyright || metadata.LicenseShortName)
        return true;
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
        (((_a = metadata.MIMEType.value) === null || _a === void 0 ? void 0 : _a.includes('image/jpeg')) ||
            ((_b = metadata.MIMEType.value) === null || _b === void 0 ? void 0 : _b.includes('image/png')))) {
        return true;
    }
    return false;
}
// Function to extract year from metadata with higher confidence
function extractYearWithConfidence(metadata, uploadYear) {
    var _a, _b;
    if (!metadata)
        return { year: uploadYear, confidence: 'medium' }; // Changed from low to medium
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
        const textToSearch = (((_a = metadata.ObjectName) === null || _a === void 0 ? void 0 : _a.value) || '') + ' ' + (((_b = metadata.ImageDescription) === null || _b === void 0 ? void 0 : _b.value) || '');
        const yearMatches = textToSearch.match(/\b(18\d{2}|19\d{2}|20\d{2})\b/g);
        if (yearMatches && yearMatches.length > 0) {
            // If same year appears multiple times, it's more likely to be correct
            const yearCounts = new Map();
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
function processDistributionData(distributions, userScore, pointCount = 25) {
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
    let percentileRank = undefined;
    if (userScore !== undefined) {
        // Count scores below user's score AND scores equal to user's score
        let scoresBelow = 0;
        let scoresEqual = 0;
        for (const item of sortedDistributions) {
            if (item.score < userScore) {
                scoresBelow += item.count;
            }
            else if (item.score === userScore) {
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
    let curvePoints = [];
    if (distributionsWithPercentiles.length <= targetPointCount) {
        // If we have fewer data points than requested, use all of them
        curvePoints = distributionsWithPercentiles.map(item => ({
            score: item.score,
            count: item.count,
            percentile: item.percentile
        }));
    }
    else {
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
                }
                else {
                    // If we can't add more unique points, break to avoid infinite loop
                    break;
                }
            }
        }
        else if (curvePoints.length > targetPointCount) {
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
function getImagesFromCategory(category, decadeRange) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const response = yield (0, node_fetch_1.default)(`https://commons.wikimedia.org/w/api.php?action=query&list=categorymembers&cmtitle=${encodeURIComponent(category)}&cmlimit=${IMAGES_PER_REQUEST}&cmtype=file&format=json`, {
                headers: {
                    'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
                }
            });
            const data = yield response.json();
            if (!data.query || !data.query.categorymembers) {
                return [];
            }
            const files = data.query.categorymembers;
            // Get details for each file
            const processedImages = yield Promise.all(files.map((file) => __awaiter(this, void 0, void 0, function* () {
                var _a, _b;
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
                const infoResponse = yield (0, node_fetch_1.default)(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(file.title)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`, {
                    headers: {
                        'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
                    }
                });
                const infoData = yield infoResponse.json();
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
                const { year, confidence } = extractYearWithConfidence(imageInfo.extmetadata, uploadYear);
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
                    description: ((_b = (_a = imageInfo.extmetadata) === null || _a === void 0 ? void 0 : _a.ImageDescription) === null || _b === void 0 ? void 0 : _b.value) || '',
                    filename: title
                };
            })));
            return processedImages.filter(img => img !== null);
        }
        catch (error) {
            console.error(`Error fetching from category ${category}:`, error);
            return [];
        }
    });
}
// Function to get random decade range with balanced distribution
function getRandomDecadeRange() {
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
function getRandomWikimediaImages(decadeRange) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Fetch random images from Wikimedia API
            const response = yield (0, node_fetch_1.default)(`https://commons.wikimedia.org/w/api.php?action=query&list=random&rnnamespace=6&rnlimit=${IMAGES_PER_REQUEST}&format=json`, {
                headers: {
                    'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
                }
            });
            const data = yield response.json();
            if (!data.query || !data.query.random) {
                console.error('Unexpected API response:', data);
                return [];
            }
            const randomImages = data.query.random;
            // Process each image to get more details and year information
            const processedImages = yield Promise.all(randomImages.map((img) => __awaiter(this, void 0, void 0, function* () {
                var _a, _b;
                const title = img.title.replace('File:', '');
                // Skip if not a photo file
                if (!isPhotoFile(title)) {
                    return null;
                }
                // Get image info including upload date, URL, etc.
                const infoResponse = yield (0, node_fetch_1.default)(`https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(img.title)}&prop=imageinfo&iiprop=url|timestamp|user|extmetadata|mediatype|mime&format=json`, {
                    headers: {
                        'User-Agent': 'Wikimedia Year Guessing Game/1.0 (ccreguer@gmail.com)'
                    }
                });
                const infoData = yield infoResponse.json();
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
                const { year, confidence } = extractYearWithConfidence(imageInfo.extmetadata, uploadYear);
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
                    description: ((_b = (_a = imageInfo.extmetadata) === null || _a === void 0 ? void 0 : _a.ImageDescription) === null || _b === void 0 ? void 0 : _b.value) || '',
                    filename: title
                };
            })));
            return processedImages.filter(img => img !== null);
        }
        catch (error) {
            console.error('Error fetching images from Wikimedia:', error);
            return [];
        }
    });
}
// Fetch a random image with year information, targeting specific decade
// With retry mechanism to ensure we always return an image
function getRandomImageWithYear(targetDecade) {
    return __awaiter(this, void 0, void 0, function* () {
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
                const images = yield getImagesFromCategory(randomCategory, decadeRange);
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
            }
            catch (error) {
                console.error(`Attempt ${attempt + 1} failed:`, error);
            }
        }
        // If category approach fails, try with direct random approach
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            try {
                // Get random images
                const images = yield getRandomWikimediaImages(decadeRange);
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
            }
            catch (error) {
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
    });
}
// Route to get a random image with year information
router.get('/', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Check for refresh parameter
        const forceRefresh = req.query.refresh === 'true';
        // Check for decade parameter
        let targetDecade;
        if (req.query.decade) {
            const decadeString = req.query.decade;
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
            }
            else {
                Object.keys(imageCacheByDecade).forEach(key => {
                    imageCacheByDecade[key] = [];
                });
            }
        }
        const image = yield getRandomImageWithYear(targetDecade);
        res.json(image);
    }
    catch (error) {
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
}));
/**
 * POST /api/images/daily-challenge/submit
 * Submit a score for today's challenge
 */
router.post('/daily-challenge/submit', submitLimiter, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    const sourceIp = ((_a = req.headers['x-forwarded-for']) === null || _a === void 0 ? void 0 : _a.toString().split(',')[0]) || req.socket.remoteAddress || 'unknown-ip';
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const { score, date } = req.body;
    // --- STEP 1.1: INPUT VALIDATION ---
    const numericScore = Number(score); // Convert score to number
    if (score === undefined || score === null || isNaN(numericScore) || numericScore < 0 || numericScore > 5000) {
        logger_1.default.warn(`[Submit Invalid Score] IP: ${sourceIp}, UA: "${userAgent}", Received invalid score: "${score}", Date: ${date}`);
        res.status(400).json({ error: `Invalid score value submitted. Score must be a number between 0 and 5000.` });
        return;
    }
    // --- END VALIDATION ---
    // Log the validated request
    logger_1.default.info(`[Submit Received Validated] IP: ${sourceIp}, UA: "${userAgent}", Score: ${numericScore}, Date: ${date}`);
    try {
        let startDate, endDate;
        let queryDateString;
        if (date) {
            queryDateString = date;
            startDate = new Date(queryDateString + 'T00:00:00.000Z');
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            if (isNaN(startDate.getTime())) {
                logger_1.default.warn(`[Submit Invalid Date] IP: ${sourceIp}, Invalid date format: ${date}`);
                res.status(400).json({ error: 'Invalid date format' });
                return;
            }
            logger_1.default.info(`[Submit] Processing for specific date ${queryDateString} (UTC)`);
        }
        else {
            const now = new Date();
            queryDateString = (0, date_fns_tz_1.formatInTimeZone)(now, TARGET_TIMEZONE, 'yyyy-MM-dd');
            startDate = (0, date_fns_tz_1.toZonedTime)(`${queryDateString}T00:00:00`, TARGET_TIMEZONE);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            logger_1.default.info(`[Submit] Processing for current CT date ${queryDateString} (UTC range: ${startDate.toISOString()} to ${endDate.toISOString()})`);
        }
        // --- STEP 1.4: Use Atomic Increment for Completions ---
        // Find and atomically increment completions count first
        const updatedChallenge = yield DailyChallenge_1.default.findOneAndUpdate({
            date: { $gte: startDate, $lt: endDate },
            active: true
        }, { $inc: { 'stats.completions': 1 } }, { new: true } // Return the updated document
        );
        if (!updatedChallenge) {
            logger_1.default.warn(`[Submit Not Found] Challenge not found for date: ${queryDateString}, IP: ${sourceIp}`);
            res.status(404).json({ error: 'No challenge found for this date' });
            return;
        }
        // --- Now update distributions and average score (Non-atomic part) ---
        const existingScoreIndex = updatedChallenge.stats.distributions.findIndex(d => d.score === numericScore);
        if (existingScoreIndex > -1) {
            // Atomically increment count for existing score distribution entry
            yield DailyChallenge_1.default.updateOne({ _id: updatedChallenge._id, 'stats.distributions.score': numericScore }, { $inc: { 'stats.distributions.$.count': 1 } });
            // Fetch again to get the updated count for avg score calculation
            const refreshedChallengeForAvg = yield DailyChallenge_1.default.findById(updatedChallenge._id);
            if (refreshedChallengeForAvg)
                updatedChallenge.stats = refreshedChallengeForAvg.stats;
        }
        else {
            // Atomically add the new score distribution entry
            yield DailyChallenge_1.default.updateOne({ _id: updatedChallenge._id }, { $push: { 'stats.distributions': { score: numericScore, count: 1 } } });
            // Fetch again to get the updated distribution for avg score calculation
            const refreshedChallengeForAvg = yield DailyChallenge_1.default.findById(updatedChallenge._id);
            if (refreshedChallengeForAvg)
                updatedChallenge.stats = refreshedChallengeForAvg.stats;
        }
        // Recalculate average score using the correct total completions
        const totalScoreSum = updatedChallenge.stats.distributions.reduce((sum, dist) => sum + (dist.score * dist.count), 0);
        const totalCompletions = updatedChallenge.stats.completions; // Use the already incremented value
        updatedChallenge.stats.averageScore = totalCompletions > 0 ? totalScoreSum / totalCompletions : 0;
        // Recalculate processed distribution
        const processedData = processDistributionData(updatedChallenge.stats.distributions, numericScore, 25);
        updatedChallenge.stats.processedDistribution = processedData;
        // Save the non-atomic updates (averageScore, processedDistribution)
        yield updatedChallenge.save();
        logger_1.default.info(`[Submit Success] Challenge ${updatedChallenge._id} stats updated for IP: ${sourceIp}. Completions: ${updatedChallenge.stats.completions}`);
        // Create the response object matching frontend expectations
        const responseData = {
            message: 'Score submitted successfully',
            stats: {
                averageScore: updatedChallenge.stats.averageScore,
                completions: updatedChallenge.stats.completions,
                processedDistribution: processedData
            }
        };
        logger_1.default.info(`[Submit Response] Sending response for IP: ${sourceIp}, Score: ${numericScore}`);
        res.status(200).json(responseData);
    }
    catch (err) {
        logger_1.default.error(`[Submit Error] IP: ${sourceIp}, Score: ${score}, Date: ${date}`, err);
        res.status(500).json({ error: 'Internal server error during score update' });
    }
}));
/**
 * GET /api/images/daily-challenge/distribution
 * Get processed distribution data for a specific date
 */
router.get('/daily-challenge/distribution', ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        let targetDate;
        // Parse the date parameter
        if (req.query.date) {
            const dateStr = req.query.date;
            targetDate = new Date(dateStr);
            if (isNaN(targetDate.getTime())) {
                return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
            }
        }
        else {
            // Default to today
            targetDate = new Date();
        }
        // Set to ET midnight instead of UTC
        targetDate = (0, date_fns_tz_1.toZonedTime)(`${targetDate.toISOString().split('T')[0]}T00:00:00`, TARGET_TIMEZONE);
        const nextDay = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
        // Find the challenge
        const challenge = yield DailyChallenge_1.default.findOne({
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
            ? parseInt(req.query.userScore, 10)
            : undefined;
        // Get the optional point count parameter
        const pointCount = req.query.points
            ? parseInt(req.query.points, 10)
            : 25;
        // Process the distribution data
        const processedData = processDistributionData(challenge.stats.distributions, userScore, pointCount);
        // Return the processed data
        res.status(200).json({
            date: targetDate.toISOString().split('T')[0],
            averageScore: challenge.stats.averageScore,
            completions: challenge.stats.completions,
            distribution: processedData
        });
    }
    catch (error) {
        logger_1.default.error('Error fetching distribution data:', error);
        res.status(500).json({ error: 'Failed to fetch distribution data' });
    }
})));
/**
 * GET /api/images/daily-challenge/stats
 * Get stats for today's challenge
 */
router.get('/daily-challenge/stats', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        let startDate, endDate;
        let queryDateString;
        if (req.query.date) {
            queryDateString = req.query.date;
            // Use UTC boundaries for specific date query
            startDate = new Date(queryDateString + 'T00:00:00.000Z');
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            if (isNaN(startDate.getTime())) {
                res.status(400).json({ error: 'Invalid date format' });
                return;
            }
            console.log(`[Stats Endpoint] Querying for specific date ${queryDateString} (UTC)`);
        }
        else {
            // Use CT logic to find 'today's' date if no date query param
            const now = new Date();
            queryDateString = (0, date_fns_tz_1.formatInTimeZone)(now, TARGET_TIMEZONE, 'yyyy-MM-dd');
            startDate = (0, date_fns_tz_1.toZonedTime)(`${queryDateString}T00:00:00`, TARGET_TIMEZONE);
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
            console.log(`[Stats Endpoint] Querying for current CT date ${queryDateString} (UTC range: ${startDate.toISOString()} to ${endDate.toISOString()})`);
        }
        const challenge = yield DailyChallenge_1.default.findOne({
            date: { $gte: startDate, $lt: endDate },
            active: true
        });
        if (!challenge) {
            res.status(404).json({ error: 'No challenge found for this date' });
            return;
        }
        // ... rest of stats logic ...
        res.json(challenge);
    }
    catch (err) {
        console.error('[Stats Endpoint] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}));
router.get('/daily-challenge/date/:date', ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { date } = req.params; // e.g., "2025-04-05"
        // --- USE UTC BOUNDARIES ---
        const startDate = new Date(date + 'T00:00:00.000Z');
        const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000); // Start of next day UTC
        if (isNaN(startDate.getTime())) {
            console.log(`Backend: Invalid date format received: ${date}`);
            res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
            return;
        }
        // --- END USE UTC BOUNDARIES ---
        console.log(`Backend: Querying for challenge >= ${startDate.toISOString()} and < ${endDate.toISOString()} (UTC)`); // Updated log
        const challenge = yield DailyChallenge_1.default.findOne({
            date: {
                $gte: startDate, // Use UTC start date
                $lt: endDate // Use UTC end date (exclusive)
            },
            active: true
        });
        console.log(`Backend: MongoDB Query Result (challenge): ${challenge ? `Found _id: ${challenge._id}` : 'null'}`); // Updated log
        if (!challenge) {
            console.log(`Backend: --> Entering 404 block because challenge was null for date ${date} (UTC Query).`); // Updated log
            res.status(404).json({ error: 'No daily challenge available for this date' });
            return;
        }
        res.status(200).json(challenge);
    }
    catch (error) {
        console.error('Error fetching daily challenge by date:', error);
        res.status(500).json({ error: 'Server error fetching daily challenge' });
        return;
    }
})));
// ADMIN ROUTES
const verifyAdmin = (req, res, next) => {
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
router.post('/daily-challenge/admin/create', verifyAdmin, ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { date, filenames } = req.body;
        if (!date || !Array.isArray(filenames) || filenames.length === 0) {
            return res.status(400).json({
                error: 'Invalid request. Required: date (YYYY-MM-DD) and filenames array'
            });
        }
        // Parse date
        const challengeDate = (0, date_fns_tz_1.toZonedTime)(`${date}T00:00:00`, TARGET_TIMEZONE);
        if (isNaN(challengeDate.getTime())) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }
        // Check if a challenge already exists for this date
        const existingChallenge = yield DailyChallenge_1.default.findOne({
            date: challengeDate
        });
        if (existingChallenge) {
            return res.status(409).json({
                error: 'A challenge already exists for this date',
                challengeId: existingChallenge._id
            });
        }
        // Fetch complete image data from Wikimedia
        const imageData = yield (0, wikimediaHelper_1.fetchMultipleImageData)(filenames);
        if (imageData.length === 0) {
            return res.status(400).json({
                error: 'Failed to fetch any valid image data from the provided filenames'
            });
        }
        // Create new challenge
        const newChallenge = new DailyChallenge_1.default({
            date: challengeDate,
            images: imageData,
            stats: {
                averageScore: 0,
                completions: 0,
                distributions: []
            },
            active: true
        });
        yield newChallenge.save();
        res.status(201).json({
            message: 'Daily challenge created successfully',
            challengeId: newChallenge._id,
            imageCount: imageData.length
        });
    }
    catch (error) {
        logger_1.default.error('Error creating daily challenge:', error);
        res.status(500).json({ error: 'Failed to create daily challenge' });
    }
})));
/**
 * GET /api/images/daily-challenge/dates
 * Returns all dates for which a daily challenge exists.
 */
router.get('/daily-challenge/dates', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // Optionally, you can restrict this to active challenges only
        const challenges = yield DailyChallenge_1.default.find({ active: true }, { date: 1 }).sort({ date: 1 });
        // Normalize each date to YYYY-MM-DD format
        const dates = challenges.map(challenge => new Date(challenge.date).toISOString().split('T')[0]);
        res.status(200).json({ dates });
    }
    catch (error) {
        console.error('Error fetching challenge dates:', error);
        res.status(500).json({ error: 'Failed to fetch challenge dates' });
    }
}));
/**
 * PUT /api/images/daily-challenge/admin/:id
 * Update an existing daily challenge (Admin only)
 */
router.put('/daily-challenge/admin/:id', verifyAdmin, ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { id } = req.params;
        const { date, filenames, active } = req.body;
        // Find the challenge
        const challenge = yield DailyChallenge_1.default.findById(id);
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
            const imageData = yield (0, wikimediaHelper_1.fetchMultipleImageData)(filenames);
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
        yield challenge.save();
        res.status(200).json({
            message: 'Daily challenge updated successfully',
            challenge: {
                id: challenge._id,
                date: challenge.date,
                imageCount: challenge.images.length,
                active: challenge.active
            }
        });
    }
    catch (error) {
        logger_1.default.error('Error updating daily challenge:', error);
        res.status(500).json({ error: 'Failed to update daily challenge' });
    }
})));
/**
 * GET /api/images/daily-challenge/admin/list
 * List all daily challenges (Admin only)
 */
router.get('/daily-challenge/admin/list', verifyAdmin, ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { page = 1, limit = 10 } = req.query;
        const pageNumber = parseInt(page, 10);
        const limitNumber = parseInt(limit, 10);
        const challenges = yield DailyChallenge_1.default.find()
            .sort({ date: -1 })
            .skip((pageNumber - 1) * limitNumber)
            .limit(limitNumber)
            .select('date active stats.completions _id');
        const total = yield DailyChallenge_1.default.countDocuments();
        res.status(200).json({
            challenges,
            totalPages: Math.ceil(total / limitNumber),
            currentPage: pageNumber
        });
    }
    catch (error) {
        logger_1.default.error('Error listing daily challenges:', error);
        res.status(500).json({ error: 'Failed to list daily challenges' });
    }
})));
// GET /api/images/daily-challenge/today
router.get('/daily-challenge/today', (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        // 1. Get the current date string in the target timezone
        const now = new Date(); // Current time UTC (usually from server)
        const todayDateStringCT = (0, date_fns_tz_1.formatInTimeZone)(now, TARGET_TIMEZONE, 'yyyy-MM-dd'); // Gets '2025-04-15' based on CT
        console.log(`[Today Endpoint] Current CT Date: ${todayDateStringCT}`);
        // 2. Construct UTC query boundaries based on the CT date string
        const startDate = (0, date_fns_tz_1.toZonedTime)(`${todayDateStringCT}T00:00:00`, TARGET_TIMEZONE); // Midnight CT start converted to UTC
        const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000); // 24 hours later UTC
        console.log(`[Today Endpoint] Querying for challenge >= ${startDate.toISOString()} and < ${endDate.toISOString()} (based on CT date)`);
        // 3. Query using UTC boundaries
        const challenge = yield DailyChallenge_1.default.findOne({
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
    }
    catch (err) {
        console.error('[Today Endpoint] Error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
}));
exports.default = router;
//# sourceMappingURL=images.js.map