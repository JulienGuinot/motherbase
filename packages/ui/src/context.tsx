'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MotherbaseClient, User } from '@motherbase/client';

interface AuthState {
  user: User | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  client: MotherbaseClient;
  refreshUser: () => Promise<User | null>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** The client should be a stable instance created outside render. */
export function MotherbaseProvider({
  client,
  children,
  initialUser,
}: {
  client: MotherbaseClient;
  children: ReactNode;
  initialUser?: User | null;
}) {
  const [state, setState] = useState<AuthState>({ user: initialUser ?? null, loading: initialUser === undefined });

  useEffect(() => {
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, loading: false });
    });
    return () => subscription.unsubscribe();
  }, [client]);

  const refreshUser = useCallback(async () => {
    // The verified user, from the server; the store follows through the session sync.
    const { error } = await client.auth.getSession();
    const user = (await client.hydrate())?.user ?? null;
    if (!error) setState({ user, loading: false });
    return user;
  }, [client]);

  const signOut = useCallback(async () => {
    const { error } = await client.auth.signOut();
    if (error) throw new Error(error.message || error.statusText || 'Sign out failed.');
  }, [client]);

  const value = useMemo(() => ({ client, ...state, refreshUser, signOut }), [client, state, refreshUser, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('Wrap this component in MotherbaseProvider.');
  return context;
}

export function useUser(): User | null {
  return useAuth().user;
}

/** Forms can use an explicit client or inherit it from MotherbaseProvider. */
export function useMotherbaseClient(client?: MotherbaseClient): MotherbaseClient {
  const context = useContext(AuthContext);
  if (!client && !context) throw new Error('Pass a client or wrap this component in MotherbaseProvider.');
  return client ?? context!.client;
}
