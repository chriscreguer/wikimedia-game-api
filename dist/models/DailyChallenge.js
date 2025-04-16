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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Schema definition for daily challenge
const DailyChallengeSchema = new mongoose_1.Schema({
    date: {
        type: Date,
        required: true,
        unique: true,
        index: true
    },
    images: [{
            filename: { type: String },
            title: { type: String, required: true },
            url: { type: String, required: true },
            year: { type: Number, required: true },
            source: { type: String, default: 'Wikimedia Commons' },
            description: { type: String },
            revealedDescription: { type: String } // Add this new field
        }],
    stats: {
        averageScore: { type: Number, default: 0 },
        completions: { type: Number, default: 0 },
        distributions: [{
                score: { type: Number },
                count: { type: Number, default: 0 }
            }],
        processedDistribution: {
            percentileRank: { type: Number },
            curvePoints: [{
                    score: { type: Number },
                    count: { type: Number },
                    percentile: { type: Number }
                }],
            totalParticipants: { type: Number },
            minScore: { type: Number },
            maxScore: { type: Number },
            medianScore: { type: Number }
        }
    },
    active: { type: Boolean, default: true }
}, { timestamps: true });
// Add this pre-save hook to ensure image URLs are properly formatted
// Add this pre-save hook to ensure image URLs are properly formatted
DailyChallengeSchema.pre('save', function (next) {
    // Normalize image URLs
    if (this.images && Array.isArray(this.images)) {
        this.images = this.images.map((image) => {
            // Don't modify URLs that are already S3 URLs
            if (typeof image.url === 'string' && image.url.includes('amazonaws.com')) {
                return image;
            }
            // For uploads that still use the old format
            if (typeof image.url === 'string' && image.url.includes('uploads')) {
                // Extract the filename
                let filename;
                if (image.url.includes('/uploads/')) {
                    filename = image.url.split('/uploads/').pop();
                }
                else {
                    filename = image.url.split('/').pop();
                }
                // Format as S3 URL instead of local path
                if (filename) {
                    image.url = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${filename}`;
                }
            }
            return image;
        });
    }
    next();
});
// Create and export the model
exports.default = mongoose_1.default.model('DailyChallenge', DailyChallengeSchema);
//# sourceMappingURL=DailyChallenge.js.map