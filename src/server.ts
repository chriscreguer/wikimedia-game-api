import { readdirSync } from "fs";
import { join } from "path";

try {
    const distPath = path.join(process.cwd(), 'dist');
    console.log(`📂 Checking dist contents at startup in: ${distPath}`);
    const contents = fs.readdirSync(distPath);
    console.log("📂 dist contents:", contents);
    // Optionally list deeper structure if needed, e.g., routes
    const routesPath = path.join(distPath, 'routes');
    if (fs.existsSync(routesPath)) {
        console.log("📂 dist/routes contents:", fs.readdirSync(routesPath));
    } else {
         console.log("📂 dist/routes directory not found.");
    }
} catch (err) {
    console.error("🚨 Error listing dist contents at startup:", err);
}
console.log("🔖 GIT COMMIT SHA:", process.env.RAILWAY_GIT_COMMIT_SHA || "Not Set in Environment");


import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import imagesRoutes from './routes/images';
import mongoose from 'mongoose';
import logger from './utils/logger';
import fs from 'fs';
import adminRoutes from './routes/admin';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Define uploads path consistently using absolute path with process.cwd()
const uploadsPath = path.resolve(process.cwd(), 'uploads');
console.log('ABSOLUTE Uploads directory path:', uploadsPath);
console.log('Current working directory:', process.cwd());
console.log('__dirname:', __dirname);

// Make sure the directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
  console.log('Created uploads directory at:', uploadsPath);
}

app.use(cors({
  origin: '*',  // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true  // Allow cookies if needed
}));

// Use TypeScript type safety for environment variables
const dbPassword = process.env.DB_PASSWORD || '';
const connectionString = `mongodb+srv://ccreguer:${dbPassword}@wikimediagame.pae8e.mongodb.net/?retryWrites=true&w=majority&appName=WikimediaGame`;

// Connect to MongoDB
mongoose.connect(connectionString)
  .then(() => logger.info('MongoDB connected successfully'))
  .catch(err => logger.error('MongoDB connection error:', err));



// Other middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug middleware for image URL paths
app.use('/api/images/daily-challenge', (req, res, next) => {
  logger.info(`Requested daily challenge: ${req.url}`);
  next();
});

// ***** ADD BUILD INFO ENDPOINT *****
// Define a unique timestamp string for this specific deployment attempt
const BUILD_TIMESTAMP = "2025-04-17_1116_CDT"; // <-- UPDATE THIS VALUE before deploying!

app.get('/api/build-info', (req, res) => {
    console.log(`[CONSOLE] Request received for /api/build-info`); // Add console log here too
    res.status(200).json({
        message: "Wikimedia Game API Build Info",
        buildTimestamp: BUILD_TIMESTAMP, // Return the hardcoded timestamp
        deploymentTime: new Date().toISOString() // Add current server time
    });
});
// ***** END BUILD INFO ENDPOINT *****

// Routes
app.use('/api/images', imagesRoutes);
app.use('/admin', adminRoutes);

// Health check route
app.get('/', (_req, res) => {
  res.json({ 
    status: 'API is running',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
});

export default app;