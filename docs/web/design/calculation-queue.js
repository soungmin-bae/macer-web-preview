/* Sequential, model-reusing phase relaxation queue with task-level crash recovery. */
(function (root) {
  'use strict';
  const fail = message => { throw new Error(message); };
  const clone = x => JSON.parse(JSON.stringify(x));
  const finite = x => typeof x === 'number' && Number.isFinite(x);
  const projectApi = () => root.CalculationProject || (typeof require === 'function' ? require('./calculation-project.js') : null);

  class CalculationQueue {
    constructor({ project, runner, store, now = () => performance.now(), onProgress = () => {} }) {
      this.api = projectApi();
      if (!this.api || !runner || typeof runner.runRelax !== 'function' || !store || typeof store.save !== 'function' || typeof store.commitTask !== 'function') fail('CalculationQueue requires a project contract, runner and durable store.');
      this.project = this.api.validateProject(project);
      this.runner = runner; this.store = store; this.now = now; this.onProgress = onProgress;
      this.controller = null; this.running = false;
    }
    async cancel() {
      if (!this.controller) return;
      this.controller.abort();
      await this.runner.stop?.();
    }
    async run() {
      if (this.running) fail('This calculation queue is already running.');
      this.running = true; this.controller = new AbortController();
      const startMs = this.now();
      try {
        await this.api.verifyTaskIdentities(this.project);
        const pending = this.project.tasks.some(t => t.status !== 'completed');
        if (pending) {
          const actualIdentity = await this.runner.prepare(this.project.model);
          if (actualIdentity && (actualIdentity.modelKey !== this.project.model.modelKey || actualIdentity.modelId !== this.project.model.modelId || String(actualIdentity.weightsSha256).toLowerCase() !== this.project.model.weightsSha256.toLowerCase())) fail('Runner loaded a different model identity than the phase project.');
        }
        for (const task of this.project.tasks) {
          if (task.status === 'completed') { this.project.metrics.reused++; continue; }
          if (this.controller.signal.aborted) { this.project.state = 'cancelled'; break; }
          const restarting = task.attempts > 0 || ['running', 'cancelled', 'failed', 'max_steps'].includes(task.status);
          if (restarting) task.restartCount++;
          task.attempts++;
          task.status = 'running'; task.partial = null; task.attemptSummary = null;
          task.currentAttemptEvaluations = 0;
          this.project.state = 'running'; this.project.updatedAt = new Date().toISOString();
          await this.store.save(this.project);
          await this.onProgress({ type: 'task-start', task: clone(task), project: clone(this.project) });
          let lastStep = -1, lastSnapshot = null, attemptStart = this.now();
          const onSnapshot = async snapshot => {
            if (this.controller.signal.aborted) return;
            if (!snapshot || !Number.isSafeInteger(snapshot.step) || snapshot.step < 0 || snapshot.step <= lastStep || !snapshot.structure || !finite(snapshot.evaluation?.energy_ev)) fail(`Task ${task.taskId} emitted an invalid or repeated evaluation snapshot.`);
            this.api.validateGeometry(snapshot.structure, `Task ${task.taskId} evaluation geometry`);
            lastStep = snapshot.step; lastSnapshot = clone(snapshot);
            task.currentAttemptEvaluations++;
            task.attemptedEvaluations++;
            task.partial = { step: snapshot.step, structure: clone(snapshot.structure), energyEv: snapshot.evaluation.energy_ev,
              maxForceEvA: snapshot.max_force_ev_per_a, maxStressResidualGpa: snapshot.max_stress_residual_gpa ?? null };
            this.project.metrics.forceStressEvaluations++;
            this.project.updatedAt = new Date().toISOString();
            await this.store.save(this.project);
            await this.onProgress({ type: 'task-progress', task: clone(task), snapshot: clone(snapshot), project: clone(this.project) });
          };
          let runResult;
          try {
            runResult = await this.runner.runRelax(clone(task), { signal: this.controller.signal, onSnapshot });
          } catch (error) {
            const cancelled = this.controller.signal.aborted || error?.name === 'AbortError';
            task.status = cancelled ? 'cancelled' : 'failed';
            task.attemptSummary = { result: task.status, evaluations: task.currentAttemptEvaluations,
              elapsedSeconds: Math.max(0, (this.now() - attemptStart) / 1000), error: cancelled ? null : String(error?.message || error) };
            this.project.state = cancelled ? 'cancelled' : 'failed'; this.project.updatedAt = new Date().toISOString();
            await this.store.save(this.project);
            await this.onProgress({ type: task.status, task: clone(task), project: clone(this.project) });
            break;
          }
          if (!runResult || !['converged', 'max_steps', 'cancelled', 'failed'].includes(runResult.status)) fail(`Task ${task.taskId} returned an unknown Relax status.`);
          if (runResult.evaluations !== undefined && runResult.evaluations !== task.currentAttemptEvaluations) fail(`Task ${task.taskId} evaluation count does not match its snapshots.`);
          const elapsedSeconds = finite(runResult.elapsedSeconds) ? runResult.elapsedSeconds : Math.max(0, (this.now() - attemptStart) / 1000);
          if (runResult.status === 'converged') {
            const geometry = clone(runResult.geometry || lastSnapshot?.structure);
            this.api.validateGeometry(geometry, `Task ${task.taskId} converged geometry`);
            if (!finite(runResult.totalEnergyEv ?? lastSnapshot?.evaluation?.energy_ev)) fail(`Task ${task.taskId} converged without a finite total energy.`);
            if (task.currentAttemptEvaluations < 1 || (lastSnapshot && lastSnapshot.status !== 'converged')) fail(`Task ${task.taskId} convergence status disagrees with its final snapshot.`);
            task.result = { status: 'converged', taskKey: task.taskKey, phaseId: task.phaseId,
              totalEnergyEv: runResult.totalEnergyEv ?? lastSnapshot.evaluation.energy_ev, atomCount: geometry.atomic_numbers.length,
              model: clone(this.project.model), initialGeometrySha256: await this.api.hash(task.structure), finalGeometrySha256: await this.api.hash(geometry),
              relaxSettings: clone(task.settings), geometry, evaluations: task.currentAttemptEvaluations, elapsedSeconds,
              convergence: { maxForceEvA: runResult.maxForceEvA ?? lastSnapshot.max_force_ev_per_a ?? null,
                maxStressResidualGpa: runResult.maxStressResidualGpa ?? lastSnapshot.max_stress_residual_gpa ?? null } };
            task.status = 'completed'; task.partial = null; task.attemptSummary = null;
            this.project.metrics.completed++;
            this.project.updatedAt = new Date().toISOString();
            // The immutable energy and final geometry enter storage together in this single project transaction.
            await this.store.commitTask(this.project, task.taskId);
            await this.onProgress({ type: 'task-completed', task: clone(task), project: clone(this.project) });
          } else {
            task.status = runResult.status;
            task.attemptSummary = { result: runResult.status, evaluations: task.currentAttemptEvaluations, elapsedSeconds,
              energyEv: runResult.totalEnergyEv ?? lastSnapshot?.evaluation?.energy_ev ?? null,
              finalStep: lastSnapshot?.step ?? null };
            this.project.state = runResult.status === 'cancelled' ? 'cancelled' : runResult.status === 'failed' ? 'failed' : 'partial';
            this.project.updatedAt = new Date().toISOString();
            await this.store.save(this.project);
            await this.onProgress({ type: runResult.status, task: clone(task), project: clone(this.project) });
            if (runResult.status === 'cancelled' || runResult.status === 'failed') break;
          }
          delete task.currentAttemptEvaluations;
        }
        const allComplete = this.project.tasks.every(t => t.status === 'completed');
        if (allComplete) this.project.state = 'completed';
        else if (this.project.state === 'running' || this.project.state === 'queued') this.project.state = 'partial';
        this.project.metrics.elapsedSeconds += Math.max(0, (this.now() - startMs) / 1000);
        this.project.metrics.forceStressEvaluations = this.project.tasks.reduce((sum, t) => sum + t.attemptedEvaluations, 0);
        this.project.updatedAt = new Date().toISOString();
        this.project = this.api.validateProject(this.project);
        await this.store.save(this.project);
        return clone(this.project);
      } finally { this.controller = null; this.running = false; }
    }
  }

  root.CalculationQueue = CalculationQueue;
  if (typeof module === 'object' && module.exports) module.exports = CalculationQueue;
})(typeof globalThis === 'object' ? globalThis : this);
