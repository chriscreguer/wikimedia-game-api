import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import imagesRoutes from './routes/images';
import mongoose from 'mongoose';
import logger from './utils/logger';
import fs from 'fs';
import adminRoutes from './routes/admin';


const app = express();
const PORT = process.env.PORT || 8080;

// Define uploads path consistently using absolute path with process.cwd()
const uploadsPath = path.resolve(process.cwd(), 'uploads');


// Make sure the directory exists
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });

}

app.use(cors({
  origin: '*',  // Allow all origins
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true  // Allow cookies if needed
}));

// Use TypeScript type safety for environment variables
// const dbPassword = process.env.DB_PASSWORD || ''; // This will no longer be needed for the primary connection string
// const connectionString = `mongodb+srv://ccreguer:${dbPassword}@wikimediagame.pae8e.mongodb.net/?retryWrites=true&w=majority&appName=WikimediaGame`;

// Get the MongoDB URI from environment variables
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    logger.error("MongoDB connection error: MONGODB_URI environment variable not set.");
    // Optionally, exit the process if the URI is critical and not set,
    // especially for production. For now, logging might be enough,
    // but mongoose.connect will fail anyway.
    process.exit(1); // Or handle more gracefully depending on desired behavior
}

// Connect to MongoDB using the MONGODB_URI from environment variables
mongoose.connect(MONGODB_URI)
  .then(() => {
      logger.info(`MongoDB connected successfully to the database specified in MONGODB_URI.`);
      // You can log part of the URI for confirmation, but be careful not to log sensitive parts
      const safeUriToLog = MONGODB_URI.replace(/\/\/(.*):(.*)@/, '//<username>:<password>@');
      logger.info(`Connected to: ${safeUriToLog}`);
  })
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