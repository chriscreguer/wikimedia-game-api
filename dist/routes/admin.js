"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
// src/routes/admin.ts
const express_1 = __importDefault(require("express"));
const path_1 = __importDefault(require("path"));
const DailyChallenge_1 = __importDefault(require("../models/DailyChallenge"));
const wikimediaHelper_1 = require("../utils/wikimediaHelper");
const logger_1 = __importDefault(require("../utils/logger"));
const multer_1 = __importDefault(require("multer"));
const fs_1 = __importDefault(require("fs"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const multer_s3_1 = __importDefault(require("multer-s3"));
const awsConfig_1 = __importStar(require("../utils/awsConfig"));
const storage = (0, multer_s3_1.default)({
    s3: awsConfig_1.default,
    bucket: awsConfig_1.s3BucketName,
    contentType: multer_s3_1.default.AUTO_CONTENT_TYPE,
    metadata: function (req, file, cb) {
        cb(null, { fieldName: file.fieldname });
    },
    key: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path_1.default.extname(file.originalname);
        const filename = file.fieldname + '-' + uniqueSuffix + ext;
        cb(null, filename);
    }
});
// File filter to accept images and videos
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
        cb(null, true);
    }
    else {
        cb(new Error('Only image and video files are allowed!'), false);
    }
};
// Set upload limits
const upload = (0, multer_1.default)({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB max file size
        files: 5 // Max 5 files at once
    },
    fileFilter: fileFilter
});
// Wrap multer in error handling middleware
const uploadWithErrorHandling = (req, res, next) => {
    upload.array('uploadedFiles', 5)(req, res, (err) => {
        if (err instanceof multer_1.default.MulterError) {
            logger_1.default.error('Multer error:', err);
            return res.status(400).json({
                error: 'File upload error',
                details: err.message,
                code: err.code
            });
        }
        else if (err) {
            logger_1.default.error('Upload error:', err);
            return res.status(400).json({
                error: 'File upload error',
                details: err.message
            });
        }
        next();
    });
};
function getS3Url(key) {
    return __awaiter(this, void 0, void 0, function* () {
        const command = new client_s3_1.PutObjectCommand({
            Bucket: awsConfig_1.s3BucketName,
            Key: key
        });
        try {
            // This URL will be valid for 1 week (604800 seconds)
            const url = yield (0, s3_request_presigner_1.getSignedUrl)(awsConfig_1.default, command, { expiresIn: 604800 });
            return url;
        }
        catch (error) {
            logger_1.default.error('Error generating S3 URL:', error);
            return '';
        }
    });
}
const router = express_1.default.Router();
// Admin authentication middleware - using the same key as in images.ts
const verifyAdmin = (req, res, next) => {
    const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    next();
};
function normalizeImageUrl(url) {
    if (!url)
        return '';
    // If it's an S3 URL
    if (url.includes('amazonaws.com')) {
        return url; // No need to modify S3 URLs
    }
    // If it's an old uploaded image URL that hasn't been migrated
    if (url.includes('uploads')) {
        // Extract the filename
        const parts = url.split('/');
        const filename = parts[parts.length - 1];
        // Create S3 URL format
        return `https://${awsConfig_1.s3BucketName}.s3.amazonaws.com/${filename}`;
    }
    return url;
}
// Add this to admin.ts
router.get('/test-uploads', verifyAdmin, (req, res) => {
    const uploadsDir = path_1.default.join(__dirname, '../../uploads');
    fs_1.default.readdir(uploadsDir, (err, files) => {
        if (err) {
            return res.status(500).json({
                error: 'Failed to read uploads directory',
                details: err.message,
                path: uploadsDir
            });
        }
        res.status(200).json({
            message: 'Uploads directory contents',
            path: uploadsDir,
            files: files
        });
    });
});
// Serve admin dashboard
router.get('/', (req, res) => {
    res.sendFile(path_1.default.join(__dirname, '../../public/admin.html'));
});
/**
 * Create a daily challenge from Wikimedia URL(s)
 * POST /admin/daily-challenge/create
 */
router.post('/daily-challenge/create', verifyAdmin, upload.array('uploadedFiles', 5), ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { date } = req.body;
        if (!date) {
            // Delete uploaded files if there's an error
            if (req.files && Array.isArray(req.files)) {
                req.files.forEach(file => {
                    fs_1.default.unlinkSync(file.path);
                });
            }
            return res.status(400).json({ error: 'Date is required' });
        }
        // Parse date and reset to Eastern Time midnight
        const challengeDate = new Date(date + 'T00:00:00.000Z'); // Use UTC directly
        if (isNaN(challengeDate.getTime())) {
            // Delete uploaded files if there's an error
            if (req.files && Array.isArray(req.files)) {
                req.files.forEach(file => {
                    fs_1.default.unlinkSync(file.path);
                });
            }
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }
        // Process imagesOrder from the request
        let imageData = [];
        if (req.body.imagesOrder) {
            const imagesOrder = JSON.parse(req.body.imagesOrder);
            const uploadedFiles = req.files || [];
            for (const imageInfo of imagesOrder) {
                if (imageInfo.type === 'wikimedia') {
                    // Handle Wikimedia images
                    const filename = imageInfo.url ? (0, wikimediaHelper_1.extractFilenameFromUrl)(imageInfo.url) : '';
                    // Only proceed if we have a valid filename
                    if (filename) {
                        const wikimediaData = yield (0, wikimediaHelper_1.fetchImageData)(filename);
                        if (wikimediaData) {
                            // Add the custom fields from the form
                            wikimediaData.year = imageInfo.year || wikimediaData.year;
                            wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                            wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                            imageData.push(wikimediaData);
                        }
                    }
                }
                else if (imageInfo.type === 'upload') {
                    // Handle uploaded files
                    const uploadIndex = imageInfo.uploadIndex;
                    if (uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
                        const file = uploadedFiles[uploadIndex];
                        // For S3 uploads, the file object from multer-s3 includes location (the S3 URL)
                        const fileUrl = file.location;
                        imageData.push({
                            filename: file.originalname,
                            title: file.originalname,
                            url: fileUrl,
                            year: imageInfo.year || new Date().getFullYear(),
                            source: 'User Upload',
                            description: imageInfo.description || '',
                            revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
                        });
                    }
                }
            }
        }
        // Ensure we have some images
        if (imageData.length === 0) {
            // Delete uploaded files if there's an error
            if (req.files && Array.isArray(req.files)) {
                req.files.forEach(file => {
                    fs_1.default.unlinkSync(file.path);
                });
            }
            return res.status(400).json({ error: 'No valid images provided' });
        }
        // Check for append mode
        const appendImages = req.body.append === 'true';
        // Check if a challenge already exists for this date
        const startDate = new Date(date + 'T00:00:00.000Z');
        const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
        const existingChallenge = yield DailyChallenge_1.default.findOne({
            date: {
                $gte: startDate,
                $lt: endDate
            }
        });
        if (existingChallenge) {
            // Update existing challenge with new images
            if (appendImages) {
                existingChallenge.images = [...existingChallenge.images, ...imageData];
            }
            else {
                existingChallenge.images = imageData;
            }
            yield existingChallenge.save();
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
            challenge: {
                id: newChallenge._id,
                date: newChallenge.date,
                imageCount: newChallenge.images.length
            }
        });
    }
    catch (error) {
        // Delete uploaded files if there's an error
        if (req.files && Array.isArray(req.files)) {
            req.files.forEach(file => {
                fs_1.default.unlinkSync(file.path);
            });
        }
        logger_1.default.error('Error creating daily challenge:', error);
        res.status(500).json({ error: 'Failed to create daily challenge' });
    }
})));
// In the GET /daily-challenges route
router.get('/daily-challenges', verifyAdmin, (req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const challenges = yield DailyChallenge_1.default.find().sort({ date: -1 });
        // Log the first challenge's images for debugging
        if (challenges.length > 0 && challenges[0].images.length > 0) {
            logger_1.default.info('First challenge images:', JSON.stringify(challenges[0].images));
        }
        // Return challenges with plain dates for easier frontend processing
        const plainChallenges = challenges.map(challenge => {
            const plain = Object.assign(Object.assign({}, challenge.toObject()), { plainDate: '' });
            plain.plainDate = challenge.date.toISOString().split('T')[0];
            return plain;
        });
        res.status(200).json(plainChallenges);
    }
    catch (error) {
        logger_1.default.error('Error fetching daily challenges:', error);
        res.status(500).json({ error: 'Failed to fetch daily challenges' });
    }
}));
/**
 * Edit a daily challenge
 * PUT /admin/daily-challenge/:id/edit
 */
router.put('/daily-challenge/:id/edit', verifyAdmin, uploadWithErrorHandling, ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { id } = req.params;
        const { date, imagesOrder } = req.body;
        logger_1.default.info(`Editing challenge ${id}`);
        const uploadedFiles = req.files || [];
        logger_1.default.info(`Received ${uploadedFiles.length} uploaded files`);
        // Find the challenge
        const challenge = yield DailyChallenge_1.default.findById(id);
        if (!challenge) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        // Update date if provided
        if (date) {
            // Assuming 'date' from req.body is the full ISO string like "YYYY-MM-DDTHH:00:00.000Z" sent by frontend
            const parsedDate = new Date(date);
            if (isNaN(parsedDate.getTime())) {
                logger_1.default.error(`Admin Edit: Received invalid date string in body: ${date}`);
                // Optionally return a 400 error here if date is mandatory on edit and invalid
            }
            else {
                challenge.date = parsedDate; // Assign the parsed UTC date object
                logger_1.default.info(`Admin Edit: Updating challenge ${id} date to ${challenge.date.toISOString()}`);
            }
        }
        // Process image updates if provided
        if (imagesOrder) {
            try {
                const orderData = typeof imagesOrder === 'string' ? JSON.parse(imagesOrder) : imagesOrder;
                logger_1.default.info(`Processing ${orderData.length} images`);
                const updatedImages = [];
                // Process each image
                for (const imageInfo of orderData) {
                    logger_1.default.info(`Processing image of type: ${imageInfo.type}`);
                    if (imageInfo.type === 'existing') {
                        // Handle existing image
                        const index = parseInt(imageInfo.originalIndex, 10);
                        if (!isNaN(index) && index >= 0 && index < challenge.images.length) {
                            // Get existing image data
                            const existingImage = {
                                filename: challenge.images[index].filename,
                                title: challenge.images[index].title,
                                url: challenge.images[index].url,
                                year: challenge.images[index].year,
                                source: challenge.images[index].source || 'Unknown',
                                description: challenge.images[index].description || '',
                                revealedDescription: challenge.images[index].revealedDescription || ''
                            };
                            // Update fields if provided
                            if (imageInfo.year !== undefined) {
                                existingImage.year = parseInt(imageInfo.year, 10);
                            }
                            if (imageInfo.description !== undefined) {
                                existingImage.description = imageInfo.description;
                            }
                            if (imageInfo.revealedDescription !== undefined) {
                                existingImage.revealedDescription = imageInfo.revealedDescription;
                            }
                            logger_1.default.info(`Adding existing image: ${existingImage.url}`);
                            updatedImages.push(existingImage);
                        }
                        else {
                            logger_1.default.warn(`Invalid existing image index: ${imageInfo.originalIndex}`);
                        }
                    }
                    else if (imageInfo.type === 'wikimedia') {
                        // Handle Wikimedia image
                        const filename = imageInfo.url ? (0, wikimediaHelper_1.extractFilenameFromUrl)(imageInfo.url) : '';
                        if (filename) {
                            const wikimediaData = yield (0, wikimediaHelper_1.fetchImageData)(filename);
                            if (wikimediaData) {
                                wikimediaData.year = imageInfo.year || wikimediaData.year;
                                wikimediaData.description = imageInfo.description || wikimediaData.description || '';
                                wikimediaData.revealedDescription = imageInfo.revealedDescription || imageInfo.description || '';
                                logger_1.default.info(`Adding Wikimedia image: ${wikimediaData.url}`);
                                updatedImages.push(wikimediaData);
                            }
                            else {
                                logger_1.default.warn(`Failed to fetch Wikimedia data for: ${filename}`);
                            }
                        }
                        else {
                            logger_1.default.warn(`Invalid Wikimedia URL: ${imageInfo.url}`);
                        }
                    }
                    else if (imageInfo.type === 'upload') {
                        // Handle new upload
                        const uploadIndex = parseInt(imageInfo.uploadIndex, 10);
                        logger_1.default.info(`Processing upload index: ${uploadIndex} (of ${uploadedFiles.length} files)`);
                        if (!isNaN(uploadIndex) && uploadIndex >= 0 && uploadIndex < uploadedFiles.length) {
                            const file = uploadedFiles[uploadIndex];
                            logger_1.default.info(`Found uploaded file: ${file.originalname}`);
                            // Use S3 file location directly
                            const fileUrl = file.location;
                            logger_1.default.info(`Created URL for uploaded file: ${fileUrl}`);
                            updatedImages.push({
                                filename: file.originalname,
                                title: file.originalname || 'Uploaded image',
                                url: fileUrl,
                                year: imageInfo.year ? parseInt(imageInfo.year, 10) : new Date().getFullYear(),
                                source: 'User Upload',
                                description: imageInfo.description || '',
                                revealedDescription: imageInfo.revealedDescription || imageInfo.description || ''
                            });
                            logger_1.default.info(`Added uploaded image: ${fileUrl}`);
                        }
                        else {
                            logger_1.default.warn(`Invalid upload index: ${uploadIndex}`);
                        }
                    }
                }
                // Replace images if we have new ones
                if (updatedImages.length > 0) {
                    logger_1.default.info(`Replacing challenge images with ${updatedImages.length} updated images`);
                    challenge.images = updatedImages;
                }
                else {
                    logger_1.default.warn('No valid images to update');
                    return res.status(400).json({ error: 'No valid images to update' });
                }
            }
            catch (error) {
                logger_1.default.error('Error processing image updates:', error);
                return res.status(400).json({
                    error: 'Invalid image order data',
                    details: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }
        // Save the updated challenge
        yield challenge.save();
        logger_1.default.info(`Challenge ${id} updated successfully with ${challenge.images.length} images`);
        res.status(200).json({
            message: 'Challenge updated successfully',
            challenge: {
                id: challenge._id,
                date: challenge.date,
                imageCount: challenge.images.length
            }
        });
    }
    catch (error) {
        logger_1.default.error('Error updating challenge:', error);
        // Clean up uploaded files on error
        if (req.files && Array.isArray(req.files)) {
            for (const file of req.files) {
                try {
                    if (file.key) { // Only try to delete if the file was actually uploaded to S3
                        yield awsConfig_1.default.send(new client_s3_1.DeleteObjectCommand({
                            Bucket: awsConfig_1.s3BucketName,
                            Key: file.key
                        }));
                        logger_1.default.info(`Cleaned up S3 file: ${file.key}`);
                    }
                }
                catch (deleteErr) {
                    logger_1.default.error(`Failed to delete file ${file.key} from S3:`, deleteErr);
                }
            }
        }
        res.status(500).json({
            error: 'Failed to update daily challenge',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
})));
/**
 * Delete a daily challenge
 * DELETE /admin/daily-challenge/:id
 */
router.delete('/daily-challenge/:id', verifyAdmin, ((req, res) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        const { id } = req.params;
        const result = yield DailyChallenge_1.default.findByIdAndDelete(id);
        if (!result) {
            return res.status(404).json({ error: 'Challenge not found' });
        }
        res.status(200).json({ message: 'Challenge deleted successfully' });
    }
    catch (error) {
        logger_1.default.error('Error deleting daily challenge:', error);
        res.status(500).json({ error: 'Failed to delete daily challenge' });
    }
})));
exports.default = router;
//# sourceMappingURL=admin.js.map