declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): any;
    close(): void;
  }
}
declare module "node:crypto" {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: string): any;
    digest(encoding: "hex"): string;
  };
}
declare module "node:child_process" {
  export function execFile(
    file: string,
    args: string[],
    options: any,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): any;
  export function spawn(file: string, args: string[], options?: any): any;
}
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function lstatSync(path: string): any;
  export function mkdirSync(path: string, options?: any): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function realpathSync(path: string): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function rmSync(path: string, options?: any): void;
  export function symlinkSync(target: string, path: string, type?: any): void;
  export function writeFileSync(path: string, data: string, options?: any): void;
}
declare module "node:path" {
  export const sep: string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
}
declare module "node:process" {
  const process: any;
  export default process;
}
declare module "node:test" {
  const test: any;
  export default test;
}
declare module "node:assert/strict" {
  const assert: any;
  export default assert;
}
declare module "node:http" {
  export function createServer(handler: (req: any, res: any) => void | Promise<void>): any;
  export function request(options: any, callback?: (res: any) => void): any;
}
declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string);
    pathname: string;
    searchParams: { get(name: string): string | null };
  }
}
