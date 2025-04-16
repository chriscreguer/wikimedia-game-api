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
// src/scripts/migrateImageUrls.ts
const mongoose_1 = __importDefault(require("mongoose"));
const DailyChallenge_1 = __importDefault(require("../models/DailyChallenge"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const s3BucketName = process.env.AWS_S3_BUCKET_NAME;
const s3Region = process.env.AWS_REGION || 'us-east-1';
function migrateImageUrls() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Connect to MongoDB
            yield mongoose_1.default.connect(process.env.MONGODB_URI);
            console.log('Connected to MongoDB');
            // Find all challenges
            const challenges = yield DailyChallenge_1.default.find();
            console.log(`Found ${challenges.length} challenges to update`);
            let totalUpdated = 0;
            for (const challenge of challenges) {
                let wasUpdated = false;
                // Update image URLs
                if (challenge.images && Array.isArray(challenge.images)) {
                    challenge.images = challenge.images.map(image => {
                        if (typeof image.url === 'string' && image.url.includes('/uploads/')) {
                            // Extract the filename
                            const filename = image.url.split('/uploads/').pop();
                            // Create S3 URL
                            image.url = `https://${s3BucketName}.s3.${s3Region}.amazonaws.com/${filename}`;
                            wasUpdated = true;
                        }
                        return image;
                    });
                }
                if (wasUpdated) {
                    yield challenge.save();
                    totalUpdated++;
                    console.log(`Updated challenge ID: ${challenge._id}`);
                }
            }
            console.log(`Migration complete. Updated ${totalUpdated} challenges.`);
        }
        catch (error) {
            console.error('Migration failed:', error);
        }
        finally {
            yield mongoose_1.default.disconnect();
            console.log('Disconnected from MongoDB');
        }
    });
}
migrateImageUrls();
//# sourceMappingURL=migrateImageUrls.js.map