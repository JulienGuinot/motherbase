import { createContext, useContext } from 'react';

type ToastKind = 'success' | 'error' | 'warn' | 'info';
export interface Toast { id: number; kind: ToastKind; title: string; message?: string }

export const ToastCtx = createContext<{ push: (toast: Omit<Toast, 'id'>) => void }>({ push: () => {} });

export const useToast = () => useContext(ToastCtx);
