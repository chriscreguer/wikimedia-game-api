import mongoose, { Schema, Document } from 'mongoose';
import { WikimediaImage } from '../types/wikimedia';
import dotenv from 'dotenv';
dotenv.config();

// Interface for score distribution
interface ScoreDistribution {
  score: number;
  count: number;
}

interface ProcessedDistribution {
  percentileRank?: number;
  curvePoints: Array<{
    score: number;
    count: number;
    percentile: number;
  }>;
  totalParticipants: number;
  minScore: number;
  maxScore: number;
  medianScore: number;
}


// Interface for daily challenge stats
interface ChallengeStats {
  averageScore: number;
  completions: number;
  distributions: ScoreDistribution[];
  processedDistribution?: ProcessedDistribution;
}

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

// Create and export the model
export default mongoose.model<DailyChallengeDoc>('DailyChallenge', DailyChallengeSchema);