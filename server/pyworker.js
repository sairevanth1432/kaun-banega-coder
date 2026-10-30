// Worker thread that runs short Python programs with Pyodide (CPython compiled to WebAssembly).
// Each run gets a fresh namespace whose builtins are a fixed safe list: no import, open, eval, exec or getattr,
// print/input are captured, and the parent thread kills this worker if a run takes too long.
import { parentPort } from 'node:worker_threads';
import { loadPyodide } from 'pyodide';

const PRELUDE = `
import io, builtins
_SAFE = ["abs","all","any","bool","chr","dict","divmod","enumerate","filter","float","format","int","isinstance","len","list",
 "map","max","min","ord","pow","range","repr","reversed","round","set","sorted","str","sum","tuple","type","zip",
 "True","False","None","Exception","ValueError","TypeError","ZeroDivisionError","IndexError","KeyError","NameError",
 "AttributeError","EOFError","RuntimeError","ArithmeticError","LookupError","StopIteration"]
def _kbc_run(src, stdin):
    lines = iter(stdin.split("\\n")) if stdin else iter(())
    out = io.StringIO()
    def _input(prompt=""):
        out.write(str(prompt))
        try:
            return next(lines)
        except StopIteration:
            raise EOFError("EOF when reading a line")
    def _print(*a, sep=" ", end="\\n", file=None, flush=False):
        out.write((" " if sep is None else sep).join(str(x) for x in a) + ("\\n" if end is None else end))
    safe = {k: getattr(builtins, k) for k in _SAFE}
    safe["input"] = _input
    safe["print"] = _print
    g = {"__builtins__": safe, "__name__": "__main__"}
    err = None
    try:
        exec(compile(src, "<code>", "exec"), g)
    except BaseException as e:
        err = type(e).__name__ + (": " + str(e) if str(e) else "")
    return [out.getvalue()[:20000], err]
`;

const py = await loadPyodide({ stdout: () => {}, stderr: () => {} });   // student output is captured per run; nothing reaches the console
py.runPython(PRELUDE);
const run = py.globals.get('_kbc_run');
parentPort.postMessage({ ready: true });
parentPort.on('message', ({ id, code, stdin }) => {
  try {
    const r = run(String(code), String(stdin || ''));
    const [out, err] = r.toJs();
    r.destroy();
    parentPort.postMessage({ id, out, err: err || null });
  } catch (e) {
    parentPort.postMessage({ id, out: '', err: 'RunnerError: ' + (e && e.message ? e.message.split('\n').slice(-2).join(' ') : String(e)) });
  }
});
