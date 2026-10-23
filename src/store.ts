import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type EnvironmentName, type Environments, SEED_ENVIRONMENTS } from './environments.js';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface TaskRecord {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  inputRequests?: Record<string, { method: 'elicitation/create'; params: unknown }>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class TooManyTasksError extends Error {
  constructor() {
    super('Too many tasks are running');
    this.name = 'TooManyTasksError';
  }
}

interface StateFile {
  environments: Environments;
  tasks: Record<string, TaskRecord>;
}

const TERMINAL: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
const ACTIVE: readonly TaskStatus[] = ['working', 'input_required'];
const DEFAULT_TTL_MS = 3_600_000;
const DEFAULT_POLL_MS = 1000;

export class StateStore {
  private readonly path: string;
  private readonly maxActiveTasks: number;
  private readonly now: () => number;
  private state: StateFile;

  constructor(opts: { path: string; maxActiveTasks: number; now?: () => number }) {
    this.path = opts.path;
    this.maxActiveTasks = opts.maxActiveTasks;
    this.now = opts.now ?? Date.now;
    this.state = this.load();
    this.recover();
    this.purgeExpired();
    this.save();
  }

  getEnvironments(): Environments {
    return structuredClone(this.state.environments);
  }

  setVersion(env: EnvironmentName, service: string, version: string): void {
    this.state.environments[env][service] = version;
    this.save();
  }

  createTask(init: { statusMessage?: string }): TaskRecord {
    
    if (this.activeTaskCount() >= this.maxActiveTasks) throw new TooManyTasksError();
    const stamp = this.stamp();
    const task: TaskRecord = {
      taskId: randomUUID(),
      status: 'working',
      createdAt: stamp,
      lastUpdatedAt: stamp,
      ttlMs: DEFAULT_TTL_MS,
      pollIntervalMs: DEFAULT_POLL_MS,
      ...(init.statusMessage === undefined ? {} : { statusMessage: init.statusMessage }),
    };
    this.state.tasks[task.taskId] = task;
    this.save();
    return structuredClone(task);
  }

  getTask(taskId: string): TaskRecord | undefined {
    const task = this.state.tasks[taskId];
    if (task === undefined) return undefined;
    if (this.isExpired(task)) {
      delete this.state.tasks[taskId];
      this.save();
      return undefined;
    }
    return structuredClone(task);
  }

  updateTask(taskId: string, patch: Partial<Omit<TaskRecord, 'taskId' | 'createdAt'>>): TaskRecord {
    const task = this.state.tasks[taskId];
    if (task === undefined) throw new Error('Unknown task');
    if (TERMINAL.includes(task.status)) return structuredClone(task);
    Object.assign(task, patch, { lastUpdatedAt: this.stamp() });
    this.save();
    return structuredClone(task);
  }

  activeTaskCount(): number {
    return Object.values(this.state.tasks).filter((t) => ACTIVE.includes(t.status)).length;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private isExpired(task: TaskRecord): boolean {
    if (!TERMINAL.includes(task.status) || task.ttlMs === null) return false;
    return this.now() - Date.parse(task.lastUpdatedAt) > task.ttlMs;
  }

  private load(): StateFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { environments: structuredClone(SEED_ENVIRONMENTS), tasks: {} };
      }
      throw new Error('State file could not be read');
    }
    try {
      const parsed = JSON.parse(raw) as StateFile;
      if (typeof parsed !== 'object' || parsed === null || !parsed.environments || !parsed.tasks) throw new Error('shape');
      return parsed;
    } catch {
      throw new Error('State file is corrupt');
    }
  }

  private recover(): void {
    for (const task of Object.values(this.state.tasks)) {
      if (!ACTIVE.includes(task.status)) continue;
      task.status = 'failed';
      task.error = { code: -32603, message: 'Server restarted before the task finished' };
      delete task.inputRequests;
      task.lastUpdatedAt = this.stamp();
    }
  }

  private purgeExpired(): void {
    for (const [id, task] of Object.entries(this.state.tasks)) {
      if (this.isExpired(task)) delete this.state.tasks[id];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
