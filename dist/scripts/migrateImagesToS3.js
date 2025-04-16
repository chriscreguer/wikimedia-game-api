"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/scripts/migrateImagesToS3.ts
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const client_s3_1 = require("@aws-sdk/client-s3");
const awsConfig_1 = __importStar(require("../utils/awsConfig"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Path to the local uploads directory
const uploadsDir = path_1.default.resolve(process.cwd(), 'uploads');
function uploadFileToS3(filePath, fileName) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const fileContent = fs_1.default.readFileSync(filePath);
            const params = {
                Bucket: awsConfig_1.s3BucketName,
                Key: fileName,
                Body: fileContent,
                ContentType: getContentType(fileName)
            };
            yield awsConfig_1.default.send(new client_s3_1.PutObjectCommand(params));
            console.log(`Successfully uploaded ${fileName} to S3`);
            return true;
        }
        catch (error) {
            console.error(`Error uploading ${fileName}:`, error);
            return false;
        }
    });
}
function getContentType(fileName) {
    const ext = path_1.default.extname(fileName).toLowerCase();
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
function migrateImagesToS3() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            console.log(`Reading files from ${uploadsDir}`);
            // Check if directory exists
            if (!fs_1.default.existsSync(uploadsDir)) {
                console.error(`Uploads directory not found: ${uploadsDir}`);
                return;
            }
            // Get all files in the uploads directory
            const files = fs_1.default.readdirSync(uploadsDir);
            console.log(`Found ${files.length} files to migrate`);
            let successCount = 0;
            let failCount = 0;
            // Upload each file to S3
            for (const file of files) {
                const filePath = path_1.default.join(uploadsDir, file);
                // Check if it's a file (not a directory)
                if (fs_1.default.statSync(filePath).isFile()) {
                    const success = yield uploadFileToS3(filePath, file);
                    if (success) {
                        successCount++;
                    }
                    else {
                        failCount++;
                    }
                }
            }
            console.log(`Migration complete: ${successCount} successful, ${failCount} failed`);
        }
        catch (error) {
            console.error('Migration script failed:', error);
        }
    });
}
migrateImagesToS3();
//# sourceMappingURL=migrateImagesToS3.js.map