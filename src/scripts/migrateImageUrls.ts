// src/scripts/migrateImageUrls.ts
import mongoose from 'mongoose';
import DailyChallenge from '../models/DailyChallenge';
import dotenv from 'dotenv';

dotenv.config();

const s3BucketName = process.env.AWS_S3_BUCKET_NAME;
const s3Region = process.env.AWS_REGION || 'us-east-1';

async function migrateImageUrls() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI as string);


    // Find all challenges
    const challenges = await DailyChallenge.find();


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
        await challenge.save();
        totalUpdated++;
  
      }
    }


  } catch (error) {

  } finally {
    await mongoose.disconnect();

  }
}

migrateImageUrls();