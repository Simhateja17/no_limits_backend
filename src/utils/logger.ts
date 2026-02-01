export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

export class Logger {
  constructor(private service: string) {}

  debug(data: object): void {
    this.log(LogLevel.DEBUG, data, console.log);
  }

  info(data: object): void {
    this.log(LogLevel.INFO, data, console.log);
  }

  warn(data: object): void {
    this.log(LogLevel.WARN, data, console.warn);
  }

  error(data: object): void {
    this.log(LogLevel.ERROR, data, console.error);
  }

  private log(level: LogLevel, data: any, logFn: typeof console.log): void {
    const prefix = `[${this.service}]`;

    // Extract common fields
    const { event, operation, jobId, error, stack, duration, ...rest } = data;

    // Build readable message
    let message = '';

    if (event) {
      message = event.replace(/_/g, ' ');
    }
    if (operation) {
      message = `${operation}${message ? ' - ' + message : ''}`;
    }

    // Create details object (only non-empty fields)
    const details: any = {};
    Object.keys(rest).forEach(key => {
      if (rest[key] !== undefined && rest[key] !== null) {
        details[key] = rest[key];
      }
    });

    // Log based on what data we have
    if (error) {
      // Error logging
      logFn(`${prefix} ${message || 'Error'}:`, error);
      if (stack) {
        logFn(stack);
      }
      if (Object.keys(details).length > 0) {
        logFn(`${prefix} Details:`, details);
      }
    } else if (Object.keys(details).length > 0) {
      // Normal logging with details
      const summaryParts = [];
      if (message) summaryParts.push(message);
      if (duration !== undefined) summaryParts.push(`(${duration}ms)`);
      if (jobId) summaryParts.push(`[${jobId}]`);

      logFn(`${prefix} ${summaryParts.join(' ')}`, details);
    } else {
      // Simple message logging
      const summaryParts = [];
      if (message) summaryParts.push(message);
      if (duration !== undefined) summaryParts.push(`(${duration}ms)`);
      if (jobId) summaryParts.push(`[${jobId}]`);

      logFn(`${prefix} ${summaryParts.join(' ')}`);
    }
  }
}
