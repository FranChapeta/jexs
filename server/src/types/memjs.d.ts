declare module "memjs" {
  export interface ClientOptions {
    username?: string;
    password?: string;
    retries?: number;
    timeout?: number;
    failover?: boolean;
  }

  export interface SetOptions {
    expires?: number;
  }

  export type Callback<T> = (err: Error | null, result: T) => void;

  export class Client {
    static create(servers: string, options?: ClientOptions): Client;

    get(key: string, callback: Callback<Buffer | null>): void;
    set(
      key: string,
      value: string,
      options: SetOptions,
      callback: Callback<boolean>,
    ): void;
    delete(key: string, callback: Callback<boolean>): void;
    flush(callback: Callback<boolean>): void;
    close(): void;
  }

  export default { Client };
}
