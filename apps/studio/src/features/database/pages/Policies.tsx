import { useSearchParams } from 'next/navigation';
import { RlsManager } from '@/features/database/components/rls/RlsManager';

export default function Policies() {
  const searchParams = useSearchParams();
  return (
    <div className="rise flex flex-col gap-4" style={{ height: '100%' }}>
      <RlsManager wantTable={searchParams.get('table')} />
    </div>
  );
}
