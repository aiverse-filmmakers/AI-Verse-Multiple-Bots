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
}
declare module "node:fs" {
  export function mkdirSync(path: string, options?: any): void;
}
declare module "node:path" {
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
