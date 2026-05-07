/**
 * Client Task types for Signature404 marketplace
 */

export type TaskCategory = 'Design' | 'Development' | 'Marketing' | 'Content' | 'Other';

export interface ClientTask {
  title: string;
  description: string;
  budget: number; // USDC with 6 decimals
  deadlineDays: number;
  category: TaskCategory;
  client: string; // wallet address
  createdAt: number; // unix timestamp
  signature: string; // wallet signature of task hash
  cid: string; // IPFS CID of this task
}

export interface TasksIndex {
  tasks: string[]; // array of CIDs
  updatedAt: number; // unix timestamp
}
