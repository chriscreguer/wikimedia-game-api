import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import imagesRoutes from './routes/images';
import mongoose from 'mongoose';
import logger from './utils/logger';
import adminRoutes from './routes/admin';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

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