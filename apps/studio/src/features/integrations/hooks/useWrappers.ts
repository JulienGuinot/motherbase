'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/shared/lib/errors';
import { useToast } from '@/shared/lib/toast';
import { confirmDialog } from '@/shared/ui/ConfirmDialog';
import {
  wrappersApi,
  type CreateForeignTableInput,
  type CreateServerInput,
  type ForeignServer,
  type ForeignTable,
  type ImportSchemaInput,
  type WrapperName,
} from '@/features/integrations/api/wrappers.api';

export function useWrappers() {
  return useQuery({ queryKey: ['wrappers'], queryFn: wrappersApi.list });
}

/** Every Wrappers write. A server's credential lands in the Vault, so its list is refreshed too. */
export function useWrappersAdmin() {
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['wrappers'] });
    void qc.invalidateQueries({ queryKey: ['vault'] });
  };
  const succeed = (title: string) => {
    refresh();
    toast.push({ kind: 'success', title });
  };
  const fail = (title: string) => (e: unknown) => toast.push({ kind: 'error', title, message: getErrorMessage(e) });

  const enable = useMutation({
    mutationFn: (wrapper: WrapperName) => wrappersApi.enable(wrapper),
    onSuccess: (_r, wrapper) => succeed(`${wrapper} enabled`),
    onError: fail('Could not enable the wrapper'),
  });
  const createServer = useMutation({
    mutationFn: (input: CreateServerInput) => wrappersApi.createServer(input),
    onSuccess: server => succeed(`Server ${server.name} created`),
    onError: fail('Could not create the server'),
  });
  const setCredentials = useMutation({
    mutationFn: (args: { name: string; user: string; password: string }) =>
      wrappersApi.setCredentials(args.name, { user: args.user, password: args.password }),
    onSuccess: () => succeed('Credentials updated'),
    onError: fail('Could not update the credentials'),
  });
  const importSchema = useMutation({
    mutationFn: (args: { name: string; input: ImportSchemaInput }) => wrappersApi.importSchema(args.name, args.input),
    onSuccess: tables => succeed(`${tables.length} foreign table${tables.length === 1 ? '' : 's'} imported`),
    onError: fail('Import failed'),
  });
  const createTable = useMutation({
    mutationFn: (input: CreateForeignTableInput) => wrappersApi.createTable(input),
    onSuccess: table => succeed(`${table.schema}.${table.name} created`),
    onError: fail('Could not create the table'),
  });
  const dropServer = useMutation({
    mutationFn: (server: ForeignServer) => wrappersApi.dropServer(server.name),
    onSuccess: () => succeed('Server deleted'),
    onError: fail('Delete failed'),
  });
  const dropTable = useMutation({
    mutationFn: (table: ForeignTable) => wrappersApi.dropTable(table.schema, table.name),
    onSuccess: () => succeed('Foreign table deleted'),
    onError: fail('Delete failed'),
  });

  return {
    enable,
    createServer,
    setCredentials,
    importSchema,
    createTable,
    confirmDropServer: async (s: ForeignServer) => {
      const ok = await confirmDialog({
        title: `Delete foreign server "${s.name}"?`,
        description: `Drops the server, its user mapping, its ${s.foreignTables} foreign table${s.foreignTables === 1 ? '' : 's'} and its Vault credential. The remote data is untouched.`,
        confirmLabel: 'Delete server',
        tone: 'danger',
        typeToConfirm: s.name,
      });
      if (ok) dropServer.mutate(s);
    },
    confirmDropTable: async (t: ForeignTable) => {
      const ok = await confirmDialog({
        title: `Delete foreign table ${t.schema}.${t.name}?`,
        description: 'Only the local definition is dropped; the remote table or file is untouched.',
        confirmLabel: 'Delete table',
        tone: 'danger',
      });
      if (ok) dropTable.mutate(t);
    },
  };
}
