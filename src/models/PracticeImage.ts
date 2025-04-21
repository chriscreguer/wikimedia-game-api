import mongoose from 'mongoose';

const PracticeImageSchema = new mongoose.Schema({
  url: {
    type: String,
    required: true
  },
  year: {
    type: Number,
    required: true
  },
  source: {
    type: String,
    required: true
  },
  title: {
    type: String,
    required: true
  },
  description: {
    type: String
  }
});

export const PracticeImage = mongoose.model('PracticeImage', PracticeImageSchema); 