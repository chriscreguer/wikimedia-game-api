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
    console.log('Connected to MongoDB');

    // Find all challenges
    const challenges = await DailyChallenge.find();
    console.log(`Found ${challenges.length} challenges to update`);

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
        console.log(`Updated challenge ID: ${challenge._id}`);
      }
    }

    console.log(`Migration complete. Updated ${totalUpdated} challenges.`);
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

migrateImageUrls();