"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const images_1 = __importDefault(require("./routes/images"));
const mongoose_1 = __importDefault(require("mongoose"));
const logger_1 = __importDefault(require("./utils/logger"));
const fs_1 = __importDefault(require("fs"));
const admin_1 = __importDefault(require("./routes/admin"));
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8080;
// Define uploads path consistently using absolute path with process.cwd()
const uploadsPath = path_1.default.resolve(process.cwd(), 'uploads');
console.log('ABSOLUTE Uploads directory path:', uploadsPath);
console.log('Current working directory:', process.cwd());
console.log('__dirname:', __dirname);
// Make sure the directory exists
if (!fs_1.default.existsSync(uploadsPath)) {
    fs_1.default.mkdirSync(uploadsPath, { recursive: true });
    console.log('Created uploads directory at:', uploadsPath);
}
app.use((0, cors_1.default)({
    origin: '*', // Allow all origins
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true // Allow cookies if needed
}));
// Use TypeScript type safety for environment variables
const dbPassword = process.env.DB_PASSWORD || '';
const connectionString = `mongodb+srv://ccreguer:${dbPassword}@wikimediagame.pae8e.mongodb.net/?retryWrites=true&w=majority&appName=WikimediaGame`;
// Connect to MongoDB
mongoose_1.default.connect(connectionString)
    .then(() => logger_1.default.info('MongoDB connected successfully'))
    .catch(err => logger_1.default.error('MongoDB connection error:', err));
// Other middleware
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Debug middleware for image URL paths
app.use('/api/images/daily-challenge', (req, res, next) => {
    logger_1.default.info(`Requested daily challenge: ${req.url}`);
    next();
});
// Routes
app.use('/api/images', images_1.default);
app.use('/admin', admin_1.default);
// Health check route
app.get('/', (_req, res) => {
    res.json({
        status: 'API is running',
        mongodb: mongoose_1.default.connection.readyState === 1 ? 'connected' : 'disconnected'
    });
});
// Start the server
app.listen(PORT, () => {
    logger_1.default.info(`Server is running on port ${PORT}`);
});
exports.default = app;
//# sourceMappingURL=server.js.map