import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import imagesRoutes from './routes/images';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/images', imagesRoutes);

// Health check route
app.get('/', (req, res) => {
  res.json({ status: 'API is running' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

export default app;