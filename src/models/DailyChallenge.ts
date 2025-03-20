import mongoose, { Schema, Document } from 'mongoose';
import { WikimediaImage } from '../types/wikimedia';

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
  // Process each image to ensure URL is web-accessible
  if (this.images) {
    this.images = this.images.map((image: WikimediaImage) => {
      // If URL is a local file path without proper prefix
      if (image.url && image.url.includes('uploads/') && !image.url.startsWith('http') && !image.url.startsWith('/')) {
        // Add leading slash to make it a proper URL path
        image.url = `/${image.url}`;
      }
      return image;
    });
  }
  next();
});

// Create and export the model
export default mongoose.model<DailyChallengeDoc>('DailyChallenge', DailyChallengeSchema);