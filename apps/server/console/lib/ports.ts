/**
 * The slices of `child_process` and `fs/promises` the console services use.
 * Each service picks the methods it needs, so tests can fake only those.
 */
export type ExecFn = (cmd: string, args: string[], opts?: any) => Promise<{ stdout: string; stderr: string }>;

export interface ConsoleFs {
  readFile(p: string, enc: string): Promise<string>;
  writeFile(p: string, data: string, o?: any): Promise<any>;
  mkdir(p: string, o?: any): Promise<any>;
  readdir(p: string): Promise<string[]>;
  chmod(p: string, mode: number): Promise<any>;
  rm(p: string, o?: any): Promise<any>;
}
