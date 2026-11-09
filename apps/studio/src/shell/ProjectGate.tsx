'use client';

import type { ReactNode } from 'react';
import { CheckCircle2, Circle, LoaderCircle } from 'lucide-react';
import { useProjectReadiness } from '@/shared/hooks/useProjectReadiness';
import { ProjectUnavailable } from '@/shell/ProjectUnavailable';

/**
 * Holds the project shell closed until the console can reach the project's API.
 *
 * A project exists the moment it is created, but its containers take a while to
 * come up and the API inside them longer still to migrate and start listening.
 * Nothing used to sit between those two facts: opening a fresh project mounted
 * every page, every page fired its queries, the proxy forwarded them to a
 * container that was not listening, and the operator got a screenful of 502
 * toasts for a project that was working correctly and simply was not finished.
 *
 * The children do not mount until `ready`, so there is nothing to fire. This is
 * the whole point of gating at the shell rather than per page: readiness is a
 * property of the project, so one gate is both simpler and impossible to forget
 * on a page added later.
 */

interface Step {
  label: string;
  state: 'done' | 'active' | 'pending';
}

/** What the operator is actually waiting on, from the two facts we have. */
function steps(status: string | undefined, ready: boolean): Step[] {
  const running = status === 'running';
  return [
    { label: 'Containers created', state: 'done' },
    { label: 'Database started', state: running ? 'done' : 'active' },
    { label: 'Migrations and API boot', state: !running ? 'pending' : ready ? 'done' : 'active' },
  ];
}

function StepRow({ step }: { step: Step }) {
  const color =
    step.state === 'done' ? 'var(--green)' : step.state === 'active' ? 'var(--accent)' : 'var(--text-mute)';
  return (
    <li className="flex items-center gap-2.5 text-[13px]" style={{ color: step.state === 'pending' ? 'var(--text-mute)' : 'var(--text)' }}>
      {step.state === 'done' && <CheckCircle2 size={15} style={{ color }} />}
      {step.state === 'active' && <LoaderCircle size={15} className="animate-spin" style={{ color }} />}
      {step.state === 'pending' && <Circle size={15} style={{ color }} />}
      {step.label}
    </li>
  );
}

export function ProjectGate({ id, children }: { id: string | undefined; children: ReactNode }) {
  // Stops polling once ready; the health indicators keep their own poll.
  const readiness = useProjectReadiness({ poll: false });

  if (!id) return <>{children}</>;

  // The server's own answer, for when the console's view of the caller's
  // projects is stale: the pages would only repeat it as a toast each.
  if (readiness.errorStatus === 403) return <ProjectUnavailable id={id} reason="forbidden" />;
  if (readiness.errorStatus === 404) return <ProjectUnavailable id={id} reason="missing" />;

  // A failed readiness check must not lock the operator out: the endpoint is
  // new, and an older console or a lost session would otherwise leave a working
  // project permanently behind this screen. Fall through and let the pages
  // report their own errors, which is the behaviour that existed before.
  if (readiness.isError) return <>{children}</>;

  if (readiness.data?.ready !== false) {
    // Undefined on the very first render: render nothing rather than flashing
    // the waiting screen for one frame on an already-running project.
    return readiness.data ? <>{children}</> : null;
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="card rise w-full max-w-md p-6">
        <div className="flex items-center gap-2.5">
          <LoaderCircle size={16} className="animate-spin" style={{ color: 'var(--accent)' }} />
          <h1 className="text-[15px]" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
            Preparing <span className="mono">{id}</span>
          </h1>
        </div>

        <ul className="mt-5 space-y-2.5">
          {steps(readiness.data?.status, false).map(step => (
            <StepRow key={step.label} step={step} />
          ))}
        </ul>

        <p className="mt-5 text-[12px] leading-relaxed" style={{ color: 'var(--text-mute)' }}>
          {readiness.data?.status === 'running'
            ? 'The containers are up and the API is finishing its migrations. This page opens on its own.'
            : 'This project is stopped. Start it from the projects list, and this page opens on its own.'}
        </p>
      </div>
    </div>
  );
}

export default ProjectGate;
