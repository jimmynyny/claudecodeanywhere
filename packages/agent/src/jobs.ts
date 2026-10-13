import { randomUUID } from 'node:crypto';

export interface JobStep {
  name: string;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  endedAt: number | null;
  output: string | null;
  error: string | null;
}

export interface Job {
  id: string;
  kind: string;
  status: 'running' | 'done' | 'failed';
  createdAt: number;
  endedAt: number | null;
  steps: JobStep[];
  result: unknown;
  error: string | null;
}

export class Jobs {
  private map = new Map<string, Job>();

  create(kind: string): Job {
    const job: Job = { id: randomUUID().slice(0, 8), kind, status: 'running', createdAt: Date.now(), endedAt: null, steps: [], result: null, error: null };
    this.map.set(job.id, job);
    if (this.map.size > 50) {
      const oldest = this.map.keys().next().value;
      if (oldest) this.map.delete(oldest);
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.map.get(id);
  }

  async step<T>(job: Job, name: string, fn: () => Promise<T>, describe?: (r: T) => string): Promise<T> {
    const step: JobStep = { name, status: 'running', startedAt: Date.now(), endedAt: null, output: null, error: null };
    job.steps.push(step);
    try {
      const r = await fn();
      step.status = 'done';
      step.output = describe ? describe(r) : null;
      return r;
    } catch (e) {
      step.status = 'failed';
      step.error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      step.endedAt = Date.now();
    }
  }

  finish(job: Job, result: unknown): void {
    job.status = 'done';
    job.result = result;
    job.endedAt = Date.now();
  }

  fail(job: Job, e: unknown): void {
    job.status = 'failed';
    job.error = e instanceof Error ? e.message : String(e);
    job.endedAt = Date.now();
  }
}
