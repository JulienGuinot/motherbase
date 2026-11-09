import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/shared/ui/Modal';

import { markOnboardingSeen, type TourStep } from '@/shared/lib/onboarding';

/** Tracks a target element's viewport rect, live. The sidebar can be mid-transition (collapse animation) when a step mounts. */
function useTargetRect(selector?: string): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!selector) return;
    const update = () => {
      const el = document.querySelector(selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    const frame = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // Sidebar width animates on collapse/expand: poll briefly to track it instead of a resize observer per-call-site.
    const id = window.setInterval(update, 200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearInterval(id);
    };
  }, [selector]);

  return rect;
}

function StepDots({ steps, step }: { steps: TourStep[]; step: number }) {
  return (
    <div className="flex justify-center gap-1.5">
      {steps.map((_, i) => (
        <span
          key={i}
          className="h-1.5 rounded-full transition-all"
          style={{ width: i === step ? 20 : 6, background: i === step ? 'var(--accent)' : 'var(--border-strong)' }}
        />
      ))}
    </div>
  );
}

export function OnboardingTour({
  steps,
  storageKey,
  onClose,
}: {
  steps: TourStep[];
  storageKey: 'project' | 'fleet';
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const last = step === steps.length - 1;
  const current = steps[step];
  const Icon = current.icon;
  const rect = useTargetRect(current.target);

  const finish = useCallback(() => {
    markOnboardingSeen(storageKey);
    onClose();
  }, [onClose, storageKey]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') finish();
    }
    if (current.target) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current.target, finish]);

  if (current.target && rect) {
    const pad = 6;
    const cardWidth = 320;
    const spaceRight = window.innerWidth - rect.right;
    const placeRight = spaceRight > cardWidth + 24;
    const cardLeft = placeRight ? rect.right + 16 : Math.max(12, rect.left);
    const cardTop = placeRight
      ? Math.min(Math.max(12, rect.top - 8), window.innerHeight - 260)
      : Math.min(rect.bottom + 12, window.innerHeight - 260);

    return createPortal(
      <div className="fixed inset-0 z-50">
        {/* Dimmed backdrop with a spotlight cutout around the target */}
        <div
          className="fixed modal-fade"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 0 0 9999px rgba(4,5,7,0.72)',
            outline: '2px solid var(--accent)',
            outlineOffset: 2,
            pointerEvents: 'none',
          }}
        />
        <div
          className="modal-rise absolute flex flex-col"
          style={{
            left: cardLeft,
            top: cardTop,
            width: cardWidth,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-pop)',
          }}
        >
          <div className="px-5 pt-5 pb-4">
            <div className=" flex items-start gap-3">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 'var(--radius-sm)' }}
              >
                <Icon size={16} />
              </div>
              <div>
                <h2 className="text-[16px]" style={{ color: 'var(--text)', fontWeight: 600 }}>{current.title}</h2>
                <p className="mt-1 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>{current.body}</p>
              </div>
            </div>
            <div className="mt-4"><StepDots steps={steps} step={step} /></div>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3 border-t hairline">
            <button onClick={finish} className="btn btn-ghost">Skip</button>
            {step > 0 && <button onClick={() => setStep(s => s - 1)} className="btn">Back</button>}
            <button onClick={() => (last ? finish() : setStep(s => s + 1))} className="btn btn-primary">
              {last ? 'Get started' : 'Next'}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <Modal onClose={finish} width="480px">
      <ModalHeader title={current.title} />
      <ModalBody>
        <div className="flex items-start gap-4">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 'var(--radius-md)' }}
          >
            <Icon size={20} />
          </div>
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>{current.body}</p>
        </div>
        <div className="mt-6"><StepDots steps={steps} step={step} /></div>
      </ModalBody>
      <ModalFooter>
        <button onClick={finish} className="btn btn-ghost">Skip</button>
        {step > 0 && (
          <button onClick={() => setStep(s => s - 1)} className="btn">Back</button>
        )}
        <button onClick={() => (last ? finish() : setStep(s => s + 1))} className="btn btn-primary">
          {last ? 'Get started' : 'Next'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
