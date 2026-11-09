import type { AgentMessage, ToolCall } from './types';

export interface ThreadScope {
  project: string;
  userId: string;
}

export interface Thread {
  id: string;
  project: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Every write the agent proposed in its last turn, still awaiting a decision.
 *  The caller must resolve all of them before the conversation can continue:
 *  a partial tool_result message is malformed history (see runAgent). */
export type PendingCalls = ToolCall[];

export interface ThreadWithMessages extends Thread {
  messages: AgentMessage[];
  pending: PendingCalls | null;
}

export interface ThreadStore {
  createThread(scope: ThreadScope, title: string): Promise<Thread>;
  listThreads(scope: ThreadScope): Promise<Thread[]>;
  getThread(id: string): Promise<ThreadWithMessages | null>;
  appendMessage(threadId: string, message: AgentMessage): Promise<void>;
  setPending(threadId: string, pending: PendingCalls | null): Promise<void>;
  renameThread(id: string, title: string): Promise<void>;
  deleteThread(id: string): Promise<void>;
}
