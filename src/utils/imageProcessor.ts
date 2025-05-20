// src/utils/imageProcessor.ts
import sharp from 'sharp';
import s3Client, { s3BucketName } from './awsConfig';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import logger from './logger';
import fetch from 'node-fetch';

export interface ProcessedImageInfo {
  cloudFrontUrl: string | null; // Full CloudFront URL for the .webp image
  s3BaseIdentifier: string;   // Just the unique part, e.g., UUID or filename stem
  // We don't strictly need to return s3Keys if admin.ts doesn't use them directly after this call
}

async function uploadVariantToS3(buffer: Buffer, s3Key: string, contentType: string): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: s3BucketName,
    Key: s3Key, // s3Key will include "game-images/" prefix
    Body: buffer,
    ContentType: contentType,
  });
  await s3Client.send(command);
  logger.info(`[imageProcessor] Successfully uploaded to S3: ${s3Key}`);
}

export async function processAndStoreImageVariants(
  imageBuffer: Buffer,
  baseIdentifier: string // e.g., "your-uuid" or "multer-key-without-extension-stem"
): Promise<ProcessedImageInfo> {
  const results: ProcessedImageInfo = { cloudFrontUrl: null, s3BaseIdentifier: baseIdentifier };
  const s3ObjectPrefix = "game-images/"; // Matches CloudFront behavior path segment
  const cloudFrontDomain = process.env.CLOUDFRONT_IMAGES_DOMAIN;

  if (!cloudFrontDomain) {
    logger.error("[imageProcessor] CRITICAL: CLOUDFRONT_IMAGES_DOMAIN env var not set!");
    return results; // Return nulls, caller must handle
  }

  try {
    const webpBuffer = await sharp(imageBuffer).webp({ quality: 80 }).toBuffer();
    const webpS3Key = `${s3ObjectPrefix}${baseIdentifier}.webp`;
    await uploadVariantToS3(webpBuffer, webpS3Key, 'image/webp');
    results.cloudFrontUrl = `https://${cloudFrontDomain}/${webpS3Key}`;
  } catch (err) {
    logger.error(`[imageProcessor] Failed to process/upload WebP for ${baseIdentifier}:`, err);
    // Don't set cloudFrontUrl if WebP fails, or decide on a fallback strategy
  }

  try {
    // Always generate JPEG as a fallback, even if WebP is the primary URL stored
    const jpegBuffer = await sharp(imageBuffer).jpeg({ quality: 80 }).toBuffer();
    const jpegS3Key = `${s3ObjectPrefix}${baseIdentifier}.jpg`;
    await uploadVariantToS3(jpegBuffer, jpegS3Key, 'image/jpeg');
  } catch (err) {
    logger.error(`[imageProcessor] Failed to process/upload JPEG for ${baseIdentifier}:`, err);
  }

  return results;
}

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

export async function deleteFromS3(s3Key: string): Promise<void> {
    try {
        const command = new DeleteObjectCommand({
            Bucket: s3BucketName,
            Key: s3Key, // s3Key should be the full key of the object to delete
        });
        await s3Client.send(command);
        logger.info(`[imageProcessor] Successfully deleted from S3: ${s3Key}`);
    } catch (error) {
        logger.error(`[imageProcessor] Failed to delete ${s3Key} from S3:`, error);
    }
}