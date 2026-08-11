declare module "bun:sqlite" {
  export type DatabaseOptions = {
    readonly?: boolean;
    readwrite?: boolean;
    create?: boolean;
  };

  export class Statement {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): any;
  }

  export class Database {
    constructor(filename: string, options?: DatabaseOptions);
    query(sql: string): Statement;
    close(): void;
  }
}
