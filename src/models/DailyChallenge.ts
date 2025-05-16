import mongoose, { Schema, Document } from 'mongoose';
import { WikimediaImage } from '../types/wikimedia';
import { ScoreDistribution, ProcessedDistribution, ChallengeStats as ChallengeStatsType } from '../types/types';
import dotenv from 'dotenv';
dotenv.config();

// Define the structure for a single round's guess distribution
interface RoundGuessDistributionItem {
  roundIndex: number;
  curvePoints: Array<{
    guessedYear: number;
    density: number;
  }>;
  totalGuesses: number;
  minGuess: number;
  maxGuess: number;
  medianGuess: number;
}

// Update ChallengeStats interface
export interface ChallengeStats extends ChallengeStatsType {
  // distributions: ScoreDistribution[]; // This might be from types.ts as well
  // processedDistribution?: ProcessedDistribution; // This might be from types.ts
  roundGuessDistributions?: RoundGuessDistributionItem[]; // New field
}

// Interface for daily challenge document
export interface DailyChallengeDoc extends Document {
  date: Date;
  images: WikimediaImage[];
  stats: ChallengeStats;
  active: boolean;
  roundStatsFinalized?: boolean;
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
    filename: { type: String, required: true },
    title: { type: String, required: true },
    url: { type: String, required: true },
    year: { type: Number, required: true },
    source: { type: String, required: true },
    description: { type: String, default: '' },
    revealedDescription: { type: String, default: '' },
    s3BaseKey: { type: String, required: false }
  }],
  stats: {
    averageScore: { type: Number, default: 0 },
    completions: { type: Number, default: 0 },
    distributions: [{ // Raw score counts
      score: { type: Number, required: true },
      count: { type: Number, required: true }
    }],
    processedDistribution: { // Processed KDE results
      percentileRank: { type: Number }, // Optional, might be null
      curvePoints: [{
        score: { type: Number, required: true },
        density: { type: Number, required: true },
        percentile: { type: Number, required: true }
      }],
      // These fields are only populated after scores are submitted and processed
      totalParticipants: { type: Number, required: false },
      minScore: { type: Number, required: false },
      maxScore: { type: Number, required: false },
      medianScore: { type: Number, required: false }
    },
    roundGuessDistributions: [{ // New field for round guess distributions
      roundIndex: { type: Number, required: true },
      curvePoints: [{
        guessedYear: { type: Number, required: true },
        density: { type: Number, required: true },
      }],
      totalGuesses: { type: Number, required: true },
      minGuess: { type: Number, required: true },
      maxGuess: { type: Number, required: true },
      medianGuess: { type: Number, required: true },
    }]
  },
  active: { type: Boolean, default: true },
  roundStatsFinalized: { type: Boolean, default: false }
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
  // Only validate if processedDistribution AND curvePoints actually exist and have data
  if (this.stats.processedDistribution && Array.isArray(this.stats.processedDistribution.curvePoints) && this.stats.processedDistribution.curvePoints.length > 0) {
    const { curvePoints, totalParticipants, minScore, maxScore, medianScore } = this.stats.processedDistribution;

    // Validate each curve point
    for (const point of curvePoints) {
      if (typeof point.score !== 'number' ||
          typeof point.density !== 'number' ||
          typeof point.percentile !== 'number') {
        return next(new Error('Each curve point must have valid score, density, and percentile values'));
      }
    }

    // Validate summary statistics ONLY if they exist (since they are optional now)
    if (totalParticipants === undefined || typeof totalParticipants !== 'number' ||
        minScore === undefined || typeof minScore !== 'number' ||
        maxScore === undefined || typeof maxScore !== 'number' ||
        medianScore === undefined || typeof medianScore !== 'number') {
      return next(new Error('If curvePoints exist, processedDistribution must also have valid totalParticipants, minScore, maxScore, and medianScore'));
    }
  }

  // If processedDistribution or curvePoints don't exist or are empty, validation passes for this hook
  next();
});

// Create and export the model
export default mongoose.model<DailyChallengeDoc>('DailyChallenge', DailyChallengeSchema);