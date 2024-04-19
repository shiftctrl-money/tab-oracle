// credit to: https://medium.com/@jagadeeshgade008/efficient-log-rotation-in-node-js-with-winston-and-file-rotation-9bf94075d699
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/tab-oracle-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '512m',
      maxFiles: '30d',
    }),
  ],
});

module.exports = logger;