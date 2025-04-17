import mongoose, { Schema, Document } from 'mongoose';
import { WikimediaImage } from '../types/wikimedia';
import { ScoreDistribution, ProcessedDistribution, ChallengeStats } from '../types/types';
import dotenv from 'dotenv';
dotenv.config();

// Interface for daily challenge document
export interface DailyChallengeDoc extends Document {
  date: Date;
  images: WikimediaImage[];
  stats: ChallengeStats;
  active: boolean;
}

// Schema definition for daily challenge
const DailyChallengeSchema: Schema = new Schema({
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
    revealedDescription: { type: String }
  }],
  stats: {
    averageScore: { type: Number, default: 0 },
    completions: { type: Number, default: 0 },
    distributions: [{ // Raw score counts
      score: { type: Number, required: true },
      count: { type: Number, required: true, default: 0 }
    }],
    processedDistribution: { // Processed KDE results
      percentileRank: { type: Number }, // Optional, might be null
      curvePoints: [{
        score: { type: Number, required: true },
        density: { type: Number, required: true }, // Required density field
        percentile: { type: Number, required: true }
      }],
      totalParticipants: { type: Number, required: true },
      minScore: { type: Number, required: true },
      maxScore: { type: Number, required: true },
      medianScore: { type: Number, required: true }
    }
  },
  active: { type: Boolean, default: true }
}, { timestamps: true });

// Add this pre-save hook to ensure image URLs are properly formatted
// Add this pre-save hook to ensure image URLs are properly formatted
DailyChallengeSchema.pre<DailyChallengeDoc>('save', function(next) {
  // Normalize image URLs
  if (this.images && Array.isArray(this.images)) {
    this.images = this.images.map((image: any) => {
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
        } else {
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

// Pre-save hook to ensure processedDistribution is valid
DailyChallengeSchema.pre('save', function(this: mongoose.Document & { stats: { processedDistribution?: ProcessedDistribution } }, next) {
  // Validate processedDistribution if it exists
  if (this.stats.processedDistribution) {
    const { curvePoints, totalParticipants, minScore, maxScore, medianScore } = this.stats.processedDistribution;
    
    // Ensure all required fields are present
    if (!curvePoints || !Array.isArray(curvePoints) || curvePoints.length === 0) {
      return next(new Error('processedDistribution.curvePoints must be a non-empty array'));
    }
    
    // Validate each curve point
    for (const point of curvePoints) {
      if (typeof point.score !== 'number' || 
          typeof point.density !== 'number' || 
          typeof point.percentile !== 'number') {
        return next(new Error('Each curve point must have valid score, density, and percentile values'));
      }
    }
    
    // Validate summary statistics
    if (typeof totalParticipants !== 'number' || 
        typeof minScore !== 'number' || 
        typeof maxScore !== 'number' || 
        typeof medianScore !== 'number') {
      return next(new Error('processedDistribution must have valid totalParticipants, minScore, maxScore, and medianScore'));
    }
  }
  
  next();
});

// Create and export the model
export default mongoose.model<DailyChallengeDoc>('DailyChallenge', DailyChallengeSchema);