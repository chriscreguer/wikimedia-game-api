import mongoose, { Schema, Document } from 'mongoose';

export interface UnlimitedImageDoc extends Document {
  url: string;
  year: number;
  description?: string;
  source?: string;
  createdAt?: Date;
}

const UnlimitedImageSchema: Schema = new Schema({
  url: { type: String, required: true, unique: true },
  year: { type: Number, required: true, index: true },
  description: { type: String },
  source: { type: String, default: 'admin_upload' },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model<UnlimitedImageDoc>('UnlimitedImage', UnlimitedImageSchema); 