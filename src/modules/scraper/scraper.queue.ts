import { Logger } from '@/lib/logger';
import type { ScraperResult } from './scraper.types';

interface QueuedTask {
  id: string;
  name: string;
  execute: () => Promise<ScraperResult>;
  resolve: (value: ScraperResult) => void;
  reject: (error: Error) => void;
}

interface ScraperLane {
  queue: QueuedTask[];
  isProcessing: boolean;
  currentTask: QueuedTask | null;
  lastResult: ScraperResult | null;
}

/**
 * Queue for managing scraper tasks.
 * Each scraper name gets its own independent lane, so different scrapers can run in parallel.
 * Within the same scraper, tasks are processed sequentially.
 */
export class ScraperQueue {
  private readonly logger = new Logger(ScraperQueue.name);
  private lanes = new Map<string, ScraperLane>();

  private getLane(name: string): ScraperLane {
    if (!this.lanes.has(name)) {
      this.lanes.set(name, {
        queue: [],
        isProcessing: false,
        currentTask: null,
        lastResult: null,
      });
    }
    return this.lanes.get(name)!;
  }

  async enqueue(name: string, execute: () => Promise<ScraperResult>): Promise<ScraperResult> {
    const lane = this.getLane(name);

    return new Promise((resolve, reject) => {
      const task: QueuedTask = {
        id: `${name}-${Date.now()}`,
        name,
        execute,
        resolve,
        reject,
      };

      lane.queue.push(task);
      this.logger.log(`Task "${name}" added to queue. Lane size: ${lane.queue.length}`);

      this.processNext(name);
    });
  }

  isRunning(name?: string): boolean {
    if (name) {
      return this.getLane(name).isProcessing;
    }
    for (const lane of this.lanes.values()) {
      if (lane.isProcessing) return true;
    }
    return false;
  }

  getStatus() {
    const scrapers: Record<string, { isProcessing: boolean; currentTask: string | null; queueLength: number; queuedTasks: string[]; lastResult: ScraperResult | null }> = {};

    for (const [name, lane] of this.lanes.entries()) {
      scrapers[name] = {
        isProcessing: lane.isProcessing,
        currentTask: lane.currentTask?.name || null,
        queueLength: lane.queue.length,
        queuedTasks: lane.queue.map(t => t.name),
        lastResult: lane.lastResult,
      };
    }

    return {
      isProcessing: this.isRunning(),
      scrapers,
    };
  }

  clear(name?: string) {
    if (name) {
      const lane = this.getLane(name);
      const cleared = lane.queue.length;
      lane.queue.forEach(task => task.reject(new Error('Queue cleared')));
      lane.queue = [];
      this.logger.log(`Lane "${name}" cleared. Removed ${cleared} pending tasks.`);
      return cleared;
    }

    let total = 0;
    for (const [laneName, lane] of this.lanes.entries()) {
      total += lane.queue.length;
      lane.queue.forEach(task => task.reject(new Error('Queue cleared')));
      lane.queue = [];
      this.logger.log(`Lane "${laneName}" cleared.`);
    }
    return total;
  }

  forceReset(name?: string) {
    if (name) {
      const lane = this.getLane(name);
      const wasProcessing = lane.isProcessing;
      const currentTaskName = lane.currentTask?.name;

      lane.queue.forEach(task => task.reject(new Error('Queue force reset')));
      lane.queue = [];
      lane.isProcessing = false;
      lane.currentTask = null;

      this.logger.warn(`Lane "${name}" force reset. Was processing: ${wasProcessing}, Task: ${currentTaskName}`);
      return { wasProcessing, currentTaskName, message: `Lane "${name}" has been force reset` };
    }

    const results: Record<string, { wasProcessing: boolean; currentTaskName: string | undefined }> = {};
    for (const [laneName, lane] of this.lanes.entries()) {
      results[laneName] = { wasProcessing: lane.isProcessing, currentTaskName: lane.currentTask?.name };
      lane.queue.forEach(task => task.reject(new Error('Queue force reset')));
      lane.queue = [];
      lane.isProcessing = false;
      lane.currentTask = null;
    }

    this.logger.warn('All lanes force reset.');
    return { results, message: 'All lanes have been force reset' };
  }

  private async processNext(name: string) {
    const lane = this.getLane(name);

    if (lane.isProcessing || lane.queue.length === 0) {
      return;
    }

    lane.isProcessing = true;
    lane.currentTask = lane.queue.shift()!;

    this.logger.log(`Starting task "${lane.currentTask.name}"`);

    try {
      const result = await lane.currentTask.execute();
      lane.lastResult = result;
      this.logger.log(`Task "${lane.currentTask.name}" completed successfully`);
      lane.currentTask.resolve(result);
    } catch (error) {
      this.logger.error(`Task "${lane.currentTask.name}" failed: ${error}`);
      lane.lastResult = {
        comics: 0,
        chapters: 0,
        errors: [String(error)],
      };
      lane.currentTask.reject(error as Error);
    } finally {
      lane.currentTask = null;
      lane.isProcessing = false;
      this.processNext(name);
    }
  }
}
