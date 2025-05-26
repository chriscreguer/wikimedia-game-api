// src/scripts/migrateImagesToS3.ts
import fs from 'fs';
import path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import s3Client, { s3BucketName } from '../utils/awsConfig';
import dotenv from 'dotenv';

dotenv.config();

// Path to the local uploads directory
const uploadsDir = path.resolve(process.cwd(), 'uploads');

async function uploadFileToS3(filePath: string, fileName: string) {
  try {
    const fileContent = fs.readFileSync(filePath);
    const params = {
      Bucket: s3BucketName,
      Key: fileName,
      Body: fileContent,
      ContentType: getContentType(fileName)
    };

    await s3Client.send(new PutObjectCommand(params));

    return true;
  } catch (error) {

    return false;
  }
}

function getContentType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}


async function migrateImagesToS3() {
  try {

    
    // Check if directory exists
    if (!fs.existsSync(uploadsDir)) {

      return;
    }

    // Get all files in the uploads directory
    const files = fs.readdirSync(uploadsDir);


    let successCount = 0;
    let failCount = 0;

    // Upload each file to S3
    for (const file of files) {
      const filePath = path.join(uploadsDir, file);
      
      // Check if it's a file (not a directory)
      if (fs.statSync(filePath).isFile()) {
        const success = await uploadFileToS3(filePath, file);
        if (success) {
          successCount++;
        } else {
          failCount++;
        }
      }
    }

   
  } catch (error) {

  }
}

migrateImagesToS3();