'use client';

import { Copy, FileText, Play, ShieldCheck, Terminal } from 'lucide-react';
import { ContextMenu } from '@/shared/ui/ContextMenu';
import { useCopy } from '@/shared/hooks/useCopy';
import { endpointAsCurl, restTableFromPath, type Endpoint } from '@/features/api-tools/lib/endpoints';

export function EndpointContextMenu({
  x,
  y,
  endpoint,
  onClose,
  onLoad,
  onManageRls,
}: {
  x: number;
  y: number;
  endpoint: Endpoint;
  onClose: () => void;
  onLoad: (endpoint: Endpoint) => void;
  onManageRls: () => void;
}) {
  const copy = useCopy();
  const isRestTable = restTableFromPath(endpoint.path) !== null;

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: 'Load in explorer', icon: <Play size={13} />, action: () => onLoad(endpoint) },
        { type: 'separator' as const },
        { label: 'Copy path', icon: <Copy size={13} />, action: () => copy(endpoint.path, 'Path copied') },
        {
          label: 'Copy as cURL',
          icon: <Terminal size={13} />,
          action: () => copy(endpointAsCurl(endpoint, window.location.origin), 'cURL copied'),
        },
        {
          label: 'Copy sample body',
          icon: <FileText size={13} />,
          disabled: !endpoint.sampleBody,
          action: () => copy(endpoint.sampleBody ?? '', 'Body copied'),
        },
        ...(isRestTable
          ? [
              { type: 'separator' as const },
              { label: 'Manage RLS', icon: <ShieldCheck size={13} />, action: onManageRls },
            ]
          : []),
      ]}
    />
  );
}
