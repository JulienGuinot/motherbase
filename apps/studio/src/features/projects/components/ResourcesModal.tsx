import { Modal, ModalBody, ModalHeader } from '@/shared/ui/Modal';
import { ResourceLimitsForm } from '@/shared/ui/ResourceLimitsForm';
import type { ProjectUsage } from '@/features/projects/types';

export function ResourcesModal({ project, usage, onClose, onSaved }: {
  project: string;
  usage?: ProjectUsage;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal onClose={onClose} width="640px">
      <ModalHeader
        title="Resource quotas"
        description={`CPU and memory for each of ${project}'s containers, and its disk.`}
      />
      <ModalBody>
        <ResourceLimitsForm project={project} usage={usage} onSaved={onSaved} />
      </ModalBody>
    </Modal>
  );
}
