import fs from 'fs';
import path from 'path';

// Log levels
enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

class Logger {
  private logPath: string;
  
  constructor(logPath: string = 'logs') {
    this.logPath = path.resolve(process.cwd(), logPath);
    
    // Ensure log directory exists
    if (!fs.existsSync(this.logPath)) {
      fs.mkdirSync(this.logPath, { recursive: true });
    }
  }
  
  private writeLog(level: LogLevel, message: string, meta?: any): void {
    const timestamp = new Date().toISOString();
    const logFile = path.join(this.logPath, `${new Date().toISOString().split('T')[0]}.log`);
    
    const logEntry = `[${timestamp}] [${level}] ${message} ${meta ? JSON.stringify(meta) : ''}`;
    
    // Log to console
    console.log(logEntry);
    
    // Append to log file
    fs.appendFileSync(logFile, logEntry + '\n');
  }
  
  info(message: string, meta?: any): void {
    this.writeLog(LogLevel.INFO, message, meta);
  }
  
  warn(message: string, meta?: any): void {
    this.writeLog(LogLevel.WARN, message, meta);
  }
  
  error(message: string, meta?: any): void {
    this.writeLog(LogLevel.ERROR, message, meta);
  }
}

export default new Logger();