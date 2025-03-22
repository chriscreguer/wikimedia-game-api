import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import imagesRoutes from './routes/images';
import mongoose from 'mongoose';
import logger from './utils/logger';
import adminRoutes from './routes/admin';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

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

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// Debug middleware for image URL paths
app.use('/api/images/daily-challenge', (req, res, next) => {
  logger.info(`Requested daily challenge: ${req.url}`);
  next();
});

app.use('/uploads', (req, res, next) => {
  logger.info(`Requested uploaded file: ${req.url}`);
  next();
});

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