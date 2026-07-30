import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { guardSocketErrors } from "./socket-guard";

// A LogLayer-shaped stub: withError(err).debug(msg)
function makeLogger() {
  const debug = vi.fn();
  const withError = vi.fn(() => ({ debug }));
  return { logger: { withError } as never, debug, withError };
}

describe("guardSocketErrors", () => {
  it("control: an unhandled socket 'error' event throws (this is what crashes the server)", () => {
    const socket = new EventEmitter();
    expect(() => socket.emit("error", new Error("read ECONNRESET"))).toThrow("read ECONNRESET");
  });

  it("swallows socket errors on connections accepted after the guard is attached", () => {
    const server = new EventEmitter();
    const { logger, debug, withError } = makeLogger();

    guardSocketErrors(server as never, logger);

    const socket = new EventEmitter();
    server.emit("connection", socket);

    const err = new Error("read ECONNRESET");
    expect(() => socket.emit("error", err)).not.toThrow();
    expect(withError).toHaveBeenCalledWith(err);
    expect(debug).toHaveBeenCalledOnce();
  });

  it("guards every accepted connection independently", () => {
    const server = new EventEmitter();
    const { logger, debug } = makeLogger();

    guardSocketErrors(server as never, logger);

    const a = new EventEmitter();
    const b = new EventEmitter();
    server.emit("connection", a);
    server.emit("connection", b);

    expect(() => a.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(() => b.emit("error", new Error("ETIMEDOUT"))).not.toThrow();
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
