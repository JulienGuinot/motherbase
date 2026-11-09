import { History, Plus, Settings as SettingsIcon, Sparkles, X, type LucideIcon } from 'lucide-react';
import { ThinkingOrb } from '@/shared/ui/ThinkingOrb';

function HeaderButton({ label, title = label, icon: Icon, onClick }: { label: string; title?: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={title} onClick={onClick}>
      <Icon size={14} />
    </button>
  );
}

export function DockHeader({
  streaming,
  onNewConversation,
  onToggleHistory,
  onToggleSettings,
  onClose,
}: {
  streaming: boolean;
  onNewConversation: () => void;
  onToggleHistory: () => void;
  onToggleSettings: () => void;
  onClose: () => void;
}) {
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--border)' }}>
      {streaming ? <ThinkingOrb size={14} /> : <Sparkles size={14} />}
      <span className="flex-1 text-[12px] font-medium">Assistant</span>
      <HeaderButton label="New conversation" icon={Plus} onClick={onNewConversation} />
      <HeaderButton label="History" icon={History} onClick={onToggleHistory} />
      <HeaderButton label="AI settings" icon={SettingsIcon} onClick={onToggleSettings} />
      <HeaderButton label="Close the assistant" title="Close" icon={X} onClick={onClose} />
    </header>
  );
}
