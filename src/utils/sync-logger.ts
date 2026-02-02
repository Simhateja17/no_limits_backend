import { Logger } from './logger.js';

export interface StateChange {
  id: string;              // Order/Product/Return ID
  displayId: string;       // #5339, SKU-123, etc.
  oldState: string;
  newState: string;
  timestamp?: Date;
}

export interface BatchResult {
  totalProcessed: number;
  updated: number;
  unchanged: number;
  failed: number;
  stateChanges?: StateChange[];
}

export class SyncLogger {
  private logger: Logger;
  private startTime: number = 0;

  constructor(serviceName: string) {
    this.logger = new Logger(serviceName);
  }

  /**
   * Start timing a batch operation
   */
  startBatch(): void {
    this.startTime = Date.now();
  }

  /**
   * Log a state change (individual)
   */
  logStateChange(change: StateChange): void {
    const timeSinceStart = this.startTime ? Date.now() - this.startTime : 0;
    this.logger.info({
      event: 'state_changed',
      id: change.displayId,
      transition: `${change.oldState} → ${change.newState}`,
      timeOffset: `${(timeSinceStart / 1000).toFixed(1)}s`
    });
  }

  /**
   * Log batch summary with processing time
   * Only logs when there are actual updates or failures (skips when everything unchanged)
   * @param force - If true, always log even when nothing changed (for manual operations)
   */
  logBatchSummary(serviceName: string, result: BatchResult, force: boolean = false): void {
    // Only log if something actually changed, failed, or forced (manual sync)
    if (!force && result.updated === 0 && result.failed === 0) {
      return;
    }

    const duration = Date.now() - this.startTime;
    const durationSec = (duration / 1000).toFixed(2);

    this.logger.info({
      event: 'batch_completed',
      service: serviceName,
      processed: result.totalProcessed,
      updated: result.updated,
      unchanged: result.unchanged,
      failed: result.failed,
      duration: `${durationSec}s`
    });
  }

  /**
   * Check if state actually changed
   */
  static hasStateChanged(oldState: string, newState: string): boolean {
    return oldState !== newState;
  }

  /**
   * Get logger for errors/warnings
   */
  getLogger(): Logger {
    return this.logger;
  }
}
