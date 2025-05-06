import mongoose, { Schema, Document } from 'mongoose';
// Import only the INTERFACES/TYPES needed from types/types
import { ProcessedDistribution, ProcessedDistributionPoint } from '../types/types'; 
import dotenv from 'dotenv';

dotenv.config();

// Interface for individual image data within a challenge
interface ChallengeImage {
  title: string;
  url: string;
  source: string;
  year: number;
  description?: string;
  filename?: string;
  revealedDescription?: string;
}

// Interface for a single point in the score distribution
interface DistributionPoint {
  score: number;
  count: number;
}

// --- NEW INTERFACES/TYPES FOR ROUND GUESS DISTRIBUTIONS --- 

// Interface for processed round guess distribution points
interface ProcessedRoundGuessDistributionPoint {
    guessedYear: number; 
    density: number;     
}

// Interface for a single round's processed guess distribution
interface ProcessedRoundGuessDistribution {
    roundIndex: number;
    curvePoints: ProcessedRoundGuessDistributionPoint[]; 
    totalGuesses: number; 
    minGuess?: number;     
    maxGuess?: number;     
    medianGuess?: number;  
}

// --- END NEW INTERFACES --- 

// Interface for the challenge statistics (using local interfaces now)
interface ChallengeStats {
  averageScore: number;
  completions: number;
  distributions: DistributionPoint[]; 
  processedDistribution?: ProcessedDistribution; // Use the TYPE from types/types
  roundGuessDistributions?: ProcessedRoundGuessDistribution[]; // Use newly defined interface
}

// --- Local Schema Definitions --- 

// Sub-schema for processed SCORE distribution points (Needs to be defined here or imported if defined elsewhere)
const ProcessedDistributionPointSchema: Schema = new Schema<ProcessedDistributionPoint>({
    score: { type: Number, required: true },
    density: { type: Number, required: true },
    percentile: { type: Number, required: true }
}, { _id: false });

// Sub-schema for processed SCORE distribution summary (Needs to be defined here or imported if defined elsewhere)
const ProcessedDistributionSchema: Schema = new Schema<ProcessedDistribution>({
    totalParticipants: { type: Number },
    curvePoints: [ProcessedDistributionPointSchema], // Use the schema defined above
    minScore: { type: Number },
    maxScore: { type: Number },
    medianScore: { type: Number }
}, { _id: false });

const ProcessedRoundGuessDistributionPointSchema: Schema = new Schema<ProcessedRoundGuessDistributionPoint>({
    guessedYear: { type: Number, required: true }, 
    density: { type: Number, required: true }     
}, { _id: false });

const ProcessedRoundGuessDistributionSchema: Schema = new Schema<ProcessedRoundGuessDistribution>({
    roundIndex: { type: Number, required: true },
    curvePoints: [ProcessedRoundGuessDistributionPointSchema], 
    totalGuesses: { type: Number, required: true }, 
    minGuess: { type: Number },                     
    maxGuess: { type: Number },                     
    medianGuess: { type: Number }                   
}, { _id: false });

// Schema for individual images
const ChallengeImageSchema: Schema = new Schema<ChallengeImage>({
  title: { type: String, required: true },
  url: { type: String, required: true },
  source: { type: String, required: true },
  year: { type: Number, required: true },
  description: { type: String },
  filename: { type: String },
  revealedDescription: { type: String, default: '' }
}, { _id: false });

// Schema for distribution points
const DistributionPointSchema: Schema = new Schema<DistributionPoint>({
  score: { type: Number, required: true },
  count: { type: Number, required: true, default: 0 }
}, { _id: false });

// Schema for challenge statistics
const ChallengeStatsSchema: Schema = new Schema<ChallengeStats>({
  averageScore: { type: Number, default: 0 },
  completions: { type: Number, default: 0 },
  distributions: [DistributionPointSchema], 
  processedDistribution: ProcessedDistributionSchema, // Use the locally defined SCHEMA
  roundGuessDistributions: [ProcessedRoundGuessDistributionSchema] 
}, { _id: false });

// Main schema for the Daily Challenge
export interface DailyChallengeDoc extends Document {
  date: Date;
  images: ChallengeImage[];
  stats: ChallengeStats;
  active: boolean;
  createdAt?: Date; 
  updatedAt?: Date; 
}

const DailyChallengeSchema: Schema = new Schema<DailyChallengeDoc>({
  date: { type: Date, required: true, index: true, unique: true },
  images: [ChallengeImageSchema],
  stats: { type: ChallengeStatsSchema, default: () => ({ completions: 0, averageScore: 0, distributions: [], roundGuessDistributions: [] }) }, // Added default for new field
  active: { type: Boolean, default: true }
}, { timestamps: true });

// Indexing fields within stats for potential queries
DailyChallengeSchema.index({ 'stats.completions': 1 });
DailyChallengeSchema.index({ 'date': 1, 'active': 1 }); // Compound index

const DailyChallenge = mongoose.model<DailyChallengeDoc>('DailyChallenge', DailyChallengeSchema);

export default DailyChallenge;