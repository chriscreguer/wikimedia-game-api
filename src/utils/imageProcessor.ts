// src/utils/imageProcessor.ts
import sharp from 'sharp';
import s3Client, { s3BucketName } from './awsConfig'; // Your existing S3 client
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import logger from './logger';
import fetch from 'node-fetch'; // Or Axios if you prefer for fetching from URL

interface ProcessedImageVariants {
  webpUrl: string | null;
  jpegUrl: string | null;
  originalKey?: string; // S3 key of the originally uploaded file by multer-s3
}

// Helper to get content type for sharp
const getSharpOutputFormat = (format: 'webp' | 'jpeg'): keyof sharp.FormatEnum => {
    return format as keyof sharp.FormatEnum;
};

async function uploadToS3(buffer: Buffer, key: string, contentType: string): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: s3BucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read', // Or your preferred ACL
  });
  await s3Client.send(command);
  
  logger.info(`[imageProcessor] s3BucketName: ${s3BucketName}`);
  logger.info(`[imageProcessor] AWS_REGION: ${process.env.AWS_REGION}`);
  const constructedUrl = `https://${s3BucketName}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
  logger.info(`[imageProcessor] Constructed URL: ${constructedUrl}`);
  return constructedUrl;
}

/**
 * Processes an image buffer into WebP and JPEG formats and uploads them to S3.
 * @param imageBuffer Buffer of the original image.
 * @param baseS3Key The base key for S3 objects (e.g., 'challenge-images/unique-id').
 * '.webp' and '.jpg' will be appended.
 * @returns {Promise<ProcessedImageVariants>} URLs of the processed images.
 */
export async function processAndUploadVariants(
  imageBuffer: Buffer,
  baseS3Key: string
): Promise<ProcessedImageVariants> {
  const results: ProcessedImageVariants = { webpUrl: null, jpegUrl: null };

  try {
    // Process WebP
    const webpBuffer = await sharp(imageBuffer)
      .webp({ quality: 80 })
      .toBuffer();
    const webpKey = `${baseS3Key}.webp`;
    results.webpUrl = await uploadToS3(webpBuffer, webpKey, 'image/webp');
    logger.info(`Uploaded WebP variant to S3: ${results.webpUrl}`);
  } catch (err) {
    logger.error(`Failed to process or upload WebP variant for ${baseS3Key}:`, err);
  }

  try {
    // Process JPEG
    const jpegBuffer = await sharp(imageBuffer)
      .jpeg({ quality: 80 })
      .toBuffer();
    const jpegKey = `${baseS3Key}.jpg`;
    results.jpegUrl = await uploadToS3(jpegBuffer, jpegKey, 'image/jpeg');
    logger.info(`Uploaded JPEG variant to S3: ${results.jpegUrl}`);
  } catch (err) {
    logger.error(`Failed to process or upload JPEG variant for ${baseS3Key}:`, err);
  }

  return results;
}

/**
 * Fetches an image from a URL.
 * @param imageUrl URL of the image to fetch.
 * @returns {Promise<Buffer | null>} Buffer of the fetched image or null on error.
 */
export async function fetchImageFromUrl(imageUrl: string): Promise<Buffer | null> {
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) {
            logger.error(`Failed to fetch image from URL: ${imageUrl}, Status: ${response.status}`);
            return null;
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (error) {
        logger.error(`Error fetching image from URL ${imageUrl}:`, error);
        return null;
    }
}

/**
 * Deletes an object from S3.
 * @param key The S3 object key to delete.
 */
export async function deleteFromS3(key: string): Promise<void> {
    try {
        const command = new DeleteObjectCommand({
            Bucket: s3BucketName,
            Key: key,
        });
        await s3Client.send(command);
        logger.info(`Successfully deleted original file from S3: ${key}`);
    } catch (error) {
        logger.error(`Failed to delete original file ${key} from S3:`, error);
    }
}