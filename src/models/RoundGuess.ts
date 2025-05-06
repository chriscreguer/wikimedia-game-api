import mongoose, { Schema, Document } from 'mongoose';

interface IRoundGuess extends Document {
    challengeDate: Date;
    roundIndex: number;
    guessedYear: number;
}

const RoundGuessSchema: Schema = new Schema<IRoundGuess>({
    challengeDate: { type: Date, required: true, index: true },
    roundIndex: { type: Number, required: true },
    guessedYear: { type: Number, required: true },
}, { timestamps: true });

const RoundGuess = mongoose.model<IRoundGuess>('RoundGuess', RoundGuessSchema);

export default RoundGuess; 