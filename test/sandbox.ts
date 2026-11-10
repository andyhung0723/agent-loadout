import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPlan } from '../src/apply.ts';
import { Backup, Documents } from '../src/documents.ts';
import { parseManifest } from '../src/manifest.ts';
import { buildPlan, type Plan } from '../src/planner.ts';
import { emptyState, type State } from '../src/state.ts';

export const TARGETS = `
[targets.claude]
tool = "claude"
dir = "~/.claude"
tags = ["personal"]

[targets.claude-work]
tool = "claude"
dir = "~/.claude-work"
tags = ["work"]

[targets.codex]
tool = "codex"
dir = "~/.codex"
tags = ["personal"]

[sources]
mine = "~/src/skills"
`;

export class Sandbox {
  readonly home: string;

  private constructor(home: string) {
    this.home = home;
  }

  static async create(): Promise<Sandbox> {
    const sandbox = new Sandbox(await mkdtemp(path.join(os.tmpdir(), 'loadout-')));
    for (const dir of ['.claude', '.claude-work', '.codex']) {
      await mkdir(sandbox.path(dir, 'skills'), { recursive: true });
    }
    return sandbox;
  }

  async dispose(): Promise<void> {
    await rm(this.home, { recursive: true, force: true });
  }

  path(...segments: string[]): string {
    return path.join(this.home, ...segments);
  }

  async write(relative: string, content: string): Promise<void> {
    await mkdir(path.dirname(this.path(relative)), { recursive: true });
    await writeFile(this.path(relative), content);
  }

  async read(relative: string): Promise<string> {
    return readFile(this.path(relative), 'utf8');
  }

  async readJson(relative: string): Promise<any> {
    return JSON.parse(await this.read(relative));
  }

  manifest(body: string) {
    return parseManifest(TARGETS + body, this.home);
  }

  async plan(body: string, state: State = emptyState()): Promise<Plan> {
    return buildPlan(this.manifest(body), state, this.#context());
  }

  async reconcile(body: string, state: State = emptyState()) {
    const context = this.#context();
    const plan = await buildPlan(this.manifest(body), state, context);
    return { plan, ...(await applyPlan(plan, state, context)) };
  }

  #context() {
    return { documents: new Documents(), backup: new Backup(this.path('.backups')) };
  }
}

export function actions(plan: Plan): string[] {
  return plan.entries.map((entry) => `${entry.action} ${entry.resource}@${entry.target}`).sort();
}
