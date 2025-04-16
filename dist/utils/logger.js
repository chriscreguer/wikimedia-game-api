"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Log levels
var LogLevel;
(function (LogLevel) {
    LogLevel["INFO"] = "INFO";
    LogLevel["WARN"] = "WARN";
    LogLevel["ERROR"] = "ERROR";
})(LogLevel || (LogLevel = {}));
class Logger {
    constructor(logPath = 'logs') {
        this.logPath = path_1.default.resolve(process.cwd(), logPath);
        // Ensure log directory exists
        if (!fs_1.default.existsSync(this.logPath)) {
            fs_1.default.mkdirSync(this.logPath, { recursive: true });
        }
    }
    writeLog(level, message, meta) {
        const timestamp = new Date().toISOString();
        const logFile = path_1.default.join(this.logPath, `${new Date().toISOString().split('T')[0]}.log`);
        const logEntry = `[${timestamp}] [${level}] ${message} ${meta ? JSON.stringify(meta) : ''}`;
        // Log to console
        console.log(logEntry);
        // Append to log file
        fs_1.default.appendFileSync(logFile, logEntry + '\n');
    }
    info(message, meta) {
        this.writeLog(LogLevel.INFO, message, meta);
    }
    warn(message, meta) {
        this.writeLog(LogLevel.WARN, message, meta);
    }
    error(message, meta) {
        this.writeLog(LogLevel.ERROR, message, meta);
    }
}
exports.default = new Logger();
//# sourceMappingURL=logger.js.map