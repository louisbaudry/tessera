import { createContext, useContext } from 'react';

export interface SessionValue {
  readonly token: string;
  /** Forgets the token and returns to the login screen. */
  readonly signOut: () => void;
}

export const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside a signed-in screen');
  return session;
}
