// Console-capturing shim for route scripts executed via @johnhenry/andbox's
// `inline` sandbox mode. Ported from vimble's InjectedConsole (prism's
// original console injection, before the vimble -> andbox migration) --
// andbox's own console capture (`onConsole`/`print`) is a different shape
// (a callback/global, not a `console`-like object), so route scripts written
// against plain `console.log(...)` keep working unchanged by passing this
// in as the `console` global instead.

export class InjectedConsole {
  #output = [];
  #errors = [];

  get output() {
    return this.#output.map((messages) => messages.join(" ")).join("\n");
  }

  get errors() {
    return this.#errors.map((messages) => messages.join(" ")).join("\n");
  }

  log(...output) {
    this.#output.push(output);
  }

  info(...output) {
    this.log(...output);
  }

  warn(...output) {
    this.log(...output);
  }

  error(...output) {
    this.#errors.push(output);
  }

  reset() {
    this.#output = [];
    this.#errors = [];
  }

  get result() {
    if (this.#errors.length > 0) {
      return this.errors;
    }
    return this.output;
  }
}

export default InjectedConsole;
